/**
 * sessions-db SessionStart hook — real main.
 *
 * The companion bootstrap (`sessions-db-session-start.mjs`) installs three
 * safety nets (uncaught handlers, kill switch, hard timeout) BEFORE
 * dynamically importing this module. That ordering guarantees that any
 * import-time failure here is caught by the bootstrap's uncaughtException
 * handler and exits 0 silently — Claude Code never sees a non-zero exit
 * from a hook that is purely observational.
 *
 * Six-item safety contract (every test below cross-references one item):
 *  1. cwd-gate: bail on any cwd that is neither a Druumen Workspace
 *     (CLAUDE.md sentinel) nor an opted-in workspace (existing
 *     `.dru-code/sessions-db.json` or `tickets/_logs/sessions-db.json`
 *     under cwd or any ancestor). No event written when both rejected.
 *  2. < 2 second budget: bootstrap's setTimeout(2000ms).unref() always wins.
 *     Each sub-probe respects a single global deadline derived from
 *     `gitContext({ totalBudgetMs })` — six probes can never sum past the
 *     budget.
 *  3. silent stderr: nothing is ever written to stderr by us. Any
 *     console.error from a transitive dep would be a test failure.
 *  4. exit 0 always: every error path — gate fail, bad input, transcript
 *     missing, lock contention, projection corrupted — exits 0 so Claude
 *     Code never sees a non-zero from a hook that is purely observational.
 *  5. kill-switch: `DRUUMEN_SESSIONS_DB_DISABLED=1` exits immediately,
 *     before any IO at all (handled in the bootstrap shim).
 *  6. shared lib reuse: git/worktree probing goes through
 *     `hooks/_lib/git-context.mjs` so hive-watcher (and future hooks) can
 *     migrate to the same probe.
 *
 * Identity reconciliation in P2: the lookup → mint → build → append → apply
 * → save sequence is now an atomic transaction inside `recordSessionSeen`,
 * which holds the projection lock across the entire critical section. Two
 * concurrent hooks for the same `claude_session_id` will serialize on the
 * lock and observe each other's mint, so identity does not split.
 *
 * cwd discipline: every storage call passes one of `{ rootPath }` or
 * `{ root }` derived from the gated cwd / git common-dir, NOT from the
 * random `process.cwd()` Claude Code happened to spawn the hook from.
 * `DRUUMEN_SESSIONS_DB_ROOT` env > auto-detected `.dru-code/` > legacy
 * `tickets/_logs/` anchored on workspace root.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  extractLatestTitles,
  findTranscriptByCsid,
  isMachineGeneratedCustomTitle,
  parseTranscriptFile,
  workspaceHashFromCwd,
} from '../lib/transcript.mjs';
import {
  CHANNEL_AGENT_NAME,
  CHANNEL_CC_AI_TITLE,
  CHANNEL_CC_CUSTOM_TITLE,
  SOURCE_HARVEST,
  SOURCE_HUMAN,
  SOURCE_LLM,
  currentNameValue,
  findNameEntry,
  isValidNameValue,
  nameSetPayload,
} from '../lib/names.mjs';
import { sanitizeFirstPrompt, sanitizeNameValue } from '../lib/sanitize.mjs';
import {
  loadProjection,
  newEvent,
  recordSessionSeen,
  tryUpdateProjection,
} from '../lib/storage.mjs';
import { gitContext } from '../lib/git-context.mjs';
import { isPromoterAlive, sweepPending, writePending } from '../lib/pending.mjs';
import {
  isDruumenWorkspace,
  isPreviewDisabled,
  looksLikeUuid,
  pickString,
  readStdinJson,
  resolveStorageTarget,
} from '../lib/hook-common.mjs';

// ---------------------------------------------------------------------------
// Top-level safety wrapper. Any unhandled rejection in main() exits 0 silently
// — never throws, never console.errors. The bootstrap shim has its own
// uncaughtException handler as a final backstop.
// ---------------------------------------------------------------------------
main().catch(() => process.exit(0));

async function main() {
  // (1) Read hook payload from stdin (best-effort, hard 100ms cap). Claude
  // Code emits a JSON line on stdin for hook scripts; we tolerate empty stdin
  // and fall through to env / cwd defaults if needed.
  const input = await readStdinJson({ timeoutMs: 100 });

  // (2) Resolve cwd — explicit input wins, then CLAUDE_PROJECT_DIR, then our
  // own process.cwd(). All three are normal Claude Code invocation surfaces.
  // CRITICAL: this `cwd` becomes the anchor for ALL downstream IO (CLAUDE.md
  // gate walk, git probe, transcript locate, storage). Once we commit to it
  // here, `process.cwd()` is never read again — protects against the case
  // where Claude Code spawns the hook from a different cwd than the project.
  const cwd = pickString(input?.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  // (3) cwd-gate. Accept the cwd when EITHER of:
  //   - a CLAUDE.md "Druumen Workspace" sentinel exists at cwd or ancestor
  //     (druumen-monorepo opt-in), OR
  //   - a `.dru-code/sessions-db.json` or `tickets/_logs/sessions-db.json`
  //     already exists under cwd or ancestor (cockpit Setup Wizard or
  //     prior manual init already opted this workspace in).
  // Any other repo bails silently.
  if (!isDruumenWorkspace(cwd)) {
    process.exit(0);
  }

  // (4) git context — bounded probes, soft-fail. We tolerate `partial` but
  // bail on `not_a_repo` (no point recording a session against a non-git dir).
  // totalBudgetMs is the SHARED budget across all probes — async runGit
  // races against a single global deadline so 6 probes cannot exceed it.
  let gitCtx;
  try {
    gitCtx = await gitContext({ cwd, totalBudgetMs: 1500 });
  } catch {
    process.exit(0);
  }
  if (gitCtx.status === 'not_a_repo') {
    process.exit(0);
  }

  // (5) Resolve the storage root (env override > auto-detected `.dru-code/`
  // > legacy `tickets/_logs/` anchored on the workspace root). Shared with
  // the UserPromptSubmit hook — see lib/hook-common.mjs for why the two must
  // agree byte-for-byte. NEVER falls back to process.cwd() — see (2).
  const workspaceRoot = gitCtx.worktreePath || cwd;
  const recordTargetOpts = resolveStorageTarget({ workspaceRoot });

  // (6) claude_session_id — required input. Without it we cannot reconcile
  // identity at all, so we bail rather than minting a stable_id we can never
  // re-correlate against the transcript file.
  const claudeSessionId = pickString(input?.session_id) ||
    process.env.CLAUDE_SESSION_ID ||
    null;
  if (!claudeSessionId || !looksLikeUuid(claudeSessionId)) {
    process.exit(0);
  }

  // (7) Locate transcript jsonl. Prefer the path the hook payload supplied;
  // otherwise compute the canonical `~/.claude/projects/<hash>/<id>.jsonl`
  // and fall back to "newest jsonl in workspace dir" if that exact file is
  // missing (Claude Code occasionally writes the file with a slight rename).
  const transcriptPath = locateTranscript({
    explicit: pickString(input?.transcript_path),
    cwd,
    claudeSessionId,
  });

  // (8) Parse transcript — best-effort. Missing / corrupted / oversized
  // transcripts leave transcriptMeta null; downstream falls through cleanly.
  let transcriptMeta = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      transcriptMeta = await parseTranscriptFile(transcriptPath);
    } catch {
      transcriptMeta = null;
    }
  }

  // (9) Compute fingerprints + first-prompt preview before the transaction
  // so the payloadBuilder closure is pure (no surprise IO inside the lock).
  const fingerprints = computeFingerprints(transcriptMeta);
  const firstPromptPreview = transcriptMeta?.firstHumanPromptRaw
    ? sanitizeFirstPrompt(transcriptMeta.firstHumanPromptRaw)
    : null;

  // (9a) DEFER GATE — the fix for ghost records.
  //
  // SessionStart fires when a Claude Code *process* comes up, which is not
  // the same event as a human starting a session. Claude Code 2.1.x keeps a
  // daemon warm-pool (`claude bg-spare` / `bg-pty-host`) and the IDE panel
  // spawns its own processes; each mints a session id and trips this hook,
  // and most are never spoken to. Measured on the reference machine: 11 of
  // 13 records created in one day were processes that never got a prompt.
  // Because the event log has no delete op, every one of them was permanent.
  //
  // So: unless we have positive evidence that this session is real, we do
  // NOT write an event. We stage a pending record instead and let the first
  // `UserPromptSubmit` promote it (lib/pending.mjs explains the design and
  // why the pending-area shape beats a `provisional: true` flag).
  //
  // Two independent pieces of evidence count as "real", either is enough:
  //
  //   (i)  the transcript already contains a human prompt — this is a
  //        resume / continue / compact of a session that has been used.
  //        `transcriptMeta.firstHumanPromptRaw` is exactly that signal.
  //   (ii) the claude_session_id is already in the projection — we have
  //        recorded this session before, so there is nothing to defer; the
  //        record exists and this observation refreshes it (branch drift,
  //        ai_title, transcript lineage).
  //
  // Order matters for cost: (i) is already computed, (ii) costs a projection
  // load. The load is unlocked, which is safe: a concurrent write could make
  // us miss a just-created record, and the only consequence is that we defer
  // a session that is already known — the promoting event then resolves to
  // the SAME stable_id via the csid index, so no identity splits and no data
  // is lost. "Cannot verify" degrades to "defer", never to "duplicate".
  // Third condition, and the one that keeps this change from being able to
  // lose data: we defer ONLY if a promoter is demonstrably alive for this
  // storage root. The two hooks are registered independently, so a user who
  // upgrades the package without adding the `UserPromptSubmit` entry to
  // settings.json would otherwise get a SessionStart that defers everything
  // and nothing that ever promotes — silently recording no sessions at all,
  // which is strictly worse than the ghosts we are removing. Without the
  // marker we fall back to the pre-0.2.0 always-record behaviour. See
  // `markPromoterAlive` in lib/pending.mjs for why this is a marker file
  // rather than a settings.json parse.
  const hasHumanPrompt = typeof transcriptMeta?.firstHumanPromptRaw === 'string' &&
    transcriptMeta.firstHumanPromptRaw.length > 0;

  if (!hasHumanPrompt &&
      isPromoterAlive(recordTargetOpts) &&
      !(await isKnownSession(claudeSessionId, recordTargetOpts))) {
    // Stage, GC, exit. No lock taken, no event appended, no projection write
    // — a warm-pool spawn now costs one small file instead of a full
    // read-modify-write cycle on the projection under contention.
    //
    // The return value is load-bearing: deferral trades "record it now" for
    // "the pending file will be promoted later", so a staged record that
    // never reached disk is a session with nothing to promote AND nothing
    // recorded. `writePending` swallows its errors by contract (full disk,
    // read-only FS, EPERM on the storage dir all return false), so ignoring
    // it turned every one of those into a silently unrecorded session. On
    // failure we fall through to the eager path below — the pre-0.2.0
    // behaviour, i.e. a ghost record at worst.
    const staged = writePending({
      claude_session_id: claudeSessionId,
      observed_at: new Date().toISOString(),
      cwd,
      source: pickString(input?.source),
      branch_at_start: gitCtx.branch,
      head_at_start: gitCtx.head,
      worktree_path_observed: gitCtx.worktreePath || cwd,
      worktree_realpath: gitCtx.worktreeRealpath,
      worktree_registry_name: gitCtx.registryName,
      git_common_dir: gitCtx.gitCommonDir,
    }, recordTargetOpts);

    if (staged) {
      // Opportunistic GC of pending records whose session never spoke.
      // Bounded readdir, no lock; keeps the staging area self-limiting
      // without a cron.
      try {
        sweepPending(recordTargetOpts);
      } catch {
        // best-effort — exit-0 contract
      }
      process.exit(0);
    }
  }

  // (9b) Privacy opt-out gate. The env var DRUUMEN_SESSIONS_DB_STORE_PREVIEW
  // mirrors the cockpit Setup Wizard's "Store first prompt preview" checkbox.
  // Only literal '0' or 'false' (case-insensitive) disables preview storage;
  // anything else (including unset) keeps the default behavior. Same
  // semantics as the kill switch (`DRUUMEN_SESSIONS_DB_DISABLED=1`) — a
  // single ENV-driven knob ops can flip without touching settings.json or
  // the hook source.
  //
  // We translate the env to a boolean here and forward it as
  // `opts.storeFirstPrompt` so the storage layer enforces the policy
  // atomically inside the lock. The boolean shape matches the public
  // library API exactly so cockpit can pass the same flag programmatically
  // when it calls recordSessionSeen directly (no env-var scaffolding).
  const storeFirstPrompt = isPreviewDisabled(
    process.env.DRUUMEN_SESSIONS_DB_STORE_PREVIEW,
  ) ? false : true;

  // (10) Hand off to the atomic recordSessionSeen transaction. It owns the
  // projection lock for the full resolve → build → append → apply → save
  // cycle, so concurrent hooks for the same claude_session_id cannot split
  // identity (each one observes the other's mint and reuses it).
  //
  // P3: storage now runs the full 3-priority identity chain (P1 csid index
  // → P2 transcript lineage → P3 fingerprint+corroborator → mint). We pass
  // ALL the signals we have so the resolver can walk the chain and surface
  // both the matched stable_id and any parent candidates (hub-spoke hints).
  //
  // Storage location: `recordTargetOpts` carries either `{ rootPath }` (env
  // override or auto-detected `.dru-code/`) or `{ root }` (legacy
  // tickets/_logs/ anchored on workspace root) — see step (5).
  let recordResult = null;
  try {
    recordResult = await recordSessionSeen({
      claudeSessionId,
      ...recordTargetOpts,
      lockTimeoutMs: 1500,
      transcriptMeta,
      gitContext: gitCtx,
      cwd,
      fingerprints,
      storeFirstPrompt,
      payloadBuilder: (_stableId, _identityResolution) => buildSessionSeenPayload({
        claudeSessionId,
        gitCtx,
        cwd,
        transcriptPath,
        transcriptMeta,
        fingerprints,
        firstPromptPreview,
      }),
    });
  } catch {
    // already exit-0 path — drop. Either the lock failed, the projection
    // is corrupt beyond repair, or events.jsonl rejected the line. The
    // SSoT is the durable record; rebuild reconciles everything later.
  }

  // (11) Name ingestion. After the session_seen event has landed and we know
  // the stable_id, tail-scan the transcript for the most recent record of
  // each naming kind Claude Code writes: `ai-title` (model-generated),
  // `custom-title` (typed by the user) and `agent-name` (agent-team badge).
  // All three are re-emitted as the session goes on; the latest occurrence of
  // each is what its surface currently shows.
  //
  // Until 0.3.0 only `ai-title` was collected, which meant the name carrying
  // the STRONGEST intent — the one a person typed by hand — existed on disk,
  // was rendered by cockpit on every refresh, and was then thrown away. It is
  // now a channel like any other.
  //
  // We keep this separate from the main `session_seen` payload because (a) a
  // name can change across SessionStart events for the same session, and (b) a
  // dedicated op (`name_set`) gives consumers a timeline of renames
  // independent of the observation events.
  //
  // Spam suppression: only append when a harvested value differs from what the
  // projection already holds for that channel. Best-effort (loadProjection
  // happens outside the lock, so there is a small race with a concurrent hook
  // for the same session) but the reducer treats a naming that re-asserts the
  // current value as a no-op, so a duplicate costs log bytes, never
  // correctness. That second half only became true once `set_count` stopped
  // self-incrementing — before that, the race added a phantom rename that no
  // rebuild could remove, because the duplicate event is in the log forever.
  if (recordResult && recordResult.ok && typeof recordResult.stableId === 'string') {
    try {
      await harvestNames({
        stableId: recordResult.stableId,
        transcriptPath,
        recordTargetOpts,
      });
    } catch {
      // Same exit-0 contract: name ingestion is best-effort. A missing
      // title doesn't degrade any existing capability — the display name
      // falls back down the chain to first_prompt_preview as before.
    }
  }

  process.exit(0);
}

/**
 * Is this claude_session_id already recorded in the projection?
 *
 * Used only by the defer gate. Deliberately reads OUTSIDE the projection lock
 * — this is an advisory check whose false-negative (a record created by a
 * concurrent hook microseconds ago) degrades to "defer this session", which
 * the next prompt repairs by resolving to the same stable_id via the csid
 * index. Taking the lock here would put every warm-pool spawn back into the
 * critical section, which is precisely what the defer gate exists to avoid.
 *
 * Any failure (missing / corrupt projection) answers `false` — unknown means
 * defer, which is the conservative direction.
 */
async function isKnownSession(claudeSessionId, recordTargetOpts) {
  try {
    const projection = await loadProjection(recordTargetOpts);
    const sessions = (projection && projection.sessions) || {};
    for (const s of Object.values(sessions)) {
      if (s && Array.isArray(s.claude_session_ids) &&
          s.claude_session_ids.includes(claudeSessionId)) {
        return true;
      }
    }
  } catch {
    // fall through — unknown
  }
  return false;
}

/**
 * Tail-scan `transcriptPath` for the most-recent record of each naming kind
 * and append a `name_set` event for every channel whose value changed.
 *
 * Why `transcriptPath` and not a re-listing: the hook already resolved the
 * canonical transcript above (`locateTranscript`) and that is the file Claude
 * Code is actively writing for THIS session. Older transcript files in the
 * workspace dir are historical — we keep them indexed in `transcript_files[]`
 * but they are not where the current names get emitted.
 *
 * One event per changed channel. In the steady state that is zero events (the
 * name has not changed since the last SessionStart) or one; three would mean
 * all three surfaces changed at once, which is not a case worth batching for.
 *
 * No-op cases (all silent — hook exit-0 contract):
 *  - transcriptPath missing or null
 *  - tail window holds no naming record at all
 *  - the value is unchanged from what the projection already has
 *  - the value fails validation (see below)
 *
 * Over-long values are dropped rather than truncated. A truncated name is a
 * name the user never chose, and storing one would also make every subsequent
 * comparison a mismatch. The measured ceiling on this machine is 62
 * characters against a 512-character cap, so this path is defensive, not hot.
 */
async function harvestNames({ stableId, transcriptPath, recordTargetOpts }) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return;
  if (!existsSync(transcriptPath)) return;

  const titles = extractLatestTitles(transcriptPath);
  if (!titles) return;

  // Channel ← record kind ← authorship. `agent-name` is recorded as `harvest`
  // rather than `human` or `llm`: it is assigned by the agent-team machinery,
  // so neither a person nor a model authored it as a name. It is also
  // deliberately outside the display chain (lib/names.mjs explains why —
  // measured, it mirrors `ai_title` exactly).
  //
  // `custom-title` is the field a person types into, EXCEPT for the one shape
  // Claude Code writes into it itself when a session is resumed from the
  // picker. That one is demoted to `harvest` — see
  // `isMachineGeneratedCustomTitle`.
  //
  // Values are sanitised here, before the change comparison, and not only
  // inside `nameSetPayload`. Comparing a raw transcript value against a
  // sanitised stored one would report "changed" on every single SessionStart
  // for any session whose title contains a tab or a stray control byte, and
  // this hook fires on every start.
  const customTitle = sanitizeNameValue(titles.customTitle ?? '');
  const candidates = [
    { channel: CHANNEL_CC_AI_TITLE, value: sanitizeNameValue(titles.aiTitle ?? ''), source: SOURCE_LLM },
    {
      channel: CHANNEL_CC_CUSTOM_TITLE,
      value: customTitle,
      source: isMachineGeneratedCustomTitle(customTitle) ? SOURCE_HARVEST : SOURCE_HUMAN,
    },
    { channel: CHANNEL_AGENT_NAME, value: sanitizeNameValue(titles.agentName ?? ''), source: SOURCE_HARVEST },
  ].filter((c) => isValidNameValue(c.value) && c.value !== null && c.value.length > 0);
  if (candidates.length === 0) return;

  // One load for all three change checks. `currentNameValue` falls back to the
  // legacy top-level fields, so a projection written before `names[]` existed
  // does not look like "every name is new" and re-emit an event for all 355
  // sessions that already have a title.
  let session = null;
  try {
    const projection = await loadProjection(recordTargetOpts);
    session = (projection && projection.sessions && projection.sessions[stableId]) || null;
  } catch {
    // ignore — a failed load only costs us duplicate suppression, and
    // durability of the audit trail is the contract that matters.
  }

  const observedAt = new Date().toISOString();
  for (const { channel, value, source } of candidates) {
    // Suppression has to agree with what the REDUCER calls a change, or the
    // two ends of the model disagree about the same event. `isSameNaming`
    // compares `(value, source)`: the same string attested by a person is a
    // different fact from one a harvester scraped, which is the entire reason
    // the `source` axis exists. A value-only check here therefore swallowed
    // re-attributions — `custom-title` moving between `harvest` and `human`
    // when `isMachineGeneratedCustomTitle` reclassifies it — and the stale
    // author label then stayed on the record permanently, because the write
    // that would have corrected it was never made.
    //
    // The author is only compared when the record HAS one. A pre-0.3.0 record
    // carries the legacy mirror and no entry, so it has no opinion about
    // authorship; demanding a match there would make every one of those
    // sessions look re-attributed and re-emit for all of them, which is the
    // regression `currentNameValue`'s fallback exists to prevent.
    const stored = session ? findNameEntry(session, channel) : null;
    const sameValue = !!session && currentNameValue(session, channel) === value;
    if (sameValue && (!stored || stored.source === source)) continue;

    const event = newEvent({
      op: 'name_set',
      stable_id: stableId,
      payload: nameSetPayload({
        channel,
        value,
        source,
        observedFrom: transcriptPath,
        observedAt,
      }),
    });

    // tryUpdateProjection holds the lock across append + apply + save, so
    // concurrent hooks cannot clobber each other's write.
    try {
      await tryUpdateProjection(event, { ...recordTargetOpts, lockTimeoutMs: 1500 });
    } catch {
      // exit-0 — durability is still ensured by tryUpdateProjection's
      // SSoT-first ordering; the next hook converges.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (unit-tested via the hook script's own integration tests rather than
// individually so we keep them private to this entry point).
// ---------------------------------------------------------------------------

/**
 * Resolve the claude transcript jsonl path. Layered, and every layer is an
 * EXACT match — no layer ever guesses.
 *
 *  1. explicit hook payload — trust it as long as the file actually exists.
 *  2. canonical path: ~/.claude/projects/<hash>/<claudeSessionId>.jsonl.
 *  3. cross-directory exact lookup: the same `<claudeSessionId>.jsonl`
 *     filename in ANY workspace dir (covers cwd/hash drift — launched from a
 *     subdirectory, symlinked cwd, workspace renamed).
 *
 * Returns null when nothing usable is found.
 *
 * ## What layer 3 used to be, and why it had to change
 *
 * Layer 3 was "newest `.jsonl` in the workspace dir, by mtime". That is a
 * guess, and it was only ever harmless by accident: `workspaceHashFromCwd`
 * mis-encoded any path containing `_`, a space, `~`, or non-ASCII, so for the
 * affected workspaces the directory was never found and the fallback returned
 * nothing at all. Fixing the hash (0.1.7) armed the guess — the directory now
 * resolves, and on this machine it holds 206 transcripts belonging to other
 * sessions. The newest of those is essentially never the caller's.
 *
 * The blast radius is not cosmetic: a wrong path lands in `transcript_files[]`
 * and feeds `first_uuid` / `last_uuid` into the P2 `transcript_lineage`
 * matcher, which can then merge two unrelated sessions into one stable_id.
 * Attaching no transcript is strictly better than attaching a stranger's.
 *
 * The replacement keeps the property the old fallback was reaching for
 * (tolerance for the transcript not living under the hash we computed) and
 * drops the property that made it dangerous (picking a file by recency
 * instead of by identity).
 */
function locateTranscript({ explicit, cwd, claudeSessionId }) {
  if (explicit && existsSync(explicit)) return explicit;

  // Canonical path computation requires an absolute cwd; we only walk this
  // path when it is. (Layer 3 does not need the cwd, so it still runs.)
  if (typeof cwd === 'string' && cwd.startsWith('/')) {
    let hash = null;
    try {
      hash = workspaceHashFromCwd(cwd);
    } catch {
      hash = null;
    }
    if (hash) {
      const canonical = join(
        process.env.HOME || '',
        '.claude',
        'projects',
        hash,
        `${claudeSessionId}.jsonl`,
      );
      if (existsSync(canonical)) return canonical;
    }
  }

  // Layer 3 — exact filename, any workspace directory. Never returns a file
  // whose name is not this session's id.
  try {
    return findTranscriptByCsid(claudeSessionId);
  } catch {
    return null;
  }
}

/**
 * Build the canonical session_seen payload from the gathered context. Pure
 * function — no IO, no time, no randomness. Called inside `recordSessionSeen`
 * with the already-resolved stable_id so the payload can include any
 * stable_id-aware fields (none in P2, but the closure shape matches the
 * recordSessionSeen contract for forward compatibility).
 */
function buildSessionSeenPayload({
  claudeSessionId,
  gitCtx,
  cwd,
  transcriptPath,
  transcriptMeta,
  fingerprints,
  firstPromptPreview,
}) {
  return {
    claude_session_id: claudeSessionId,
    branch_at_start: gitCtx.branch,
    branch_current: gitCtx.branch,
    head_at_start: gitCtx.head,
    head_last_seen: gitCtx.head,
    worktree_path_observed: gitCtx.worktreePath || cwd,
    worktree_realpath: gitCtx.worktreeRealpath,
    worktree_registry_name: gitCtx.registryName,
    git_common_dir: gitCtx.gitCommonDir,
    // transcript_file is null (→ session ends up with empty transcript_files,
    // metadata-searchable only) precisely when one of: (1) locateTranscript
    // found nothing in any tier, (2) the located path didn't exist at parse
    // time, (3) parseTranscriptFile threw, or (4) the file was oversized. NOTE:
    // tiers 2+3 of locateTranscript route through workspaceHashFromCwd, which
    // historically mis-encoded '_'/space/non-ASCII paths — see the fix in
    // lib/transcript.mjs. `search --content` has a disk fallback for the gap.
    transcript_file: transcriptMeta && transcriptPath ? {
      path: transcriptPath,
      first_uuid: transcriptMeta.firstUuid,
      last_uuid: transcriptMeta.lastUuid,
      size: transcriptMeta.size,
      // statSync()'s mtime is a Date — serialize to ISO so events.jsonl
      // round-trips cleanly through JSON.parse.
      mtime: transcriptMeta.mtime instanceof Date
        ? transcriptMeta.mtime.toISOString()
        : transcriptMeta.mtime,
      status: transcriptMeta.status,
    } : null,
    fingerprints,
    first_prompt_preview: firstPromptPreview,
    cwd,
  };
}

/**
 * Compute v1 fingerprints from transcript meta. Both algorithms hash to a
 * 16-char hex prefix of SHA-256 — short enough to dedupe in the projection
 * map without bloating event payloads.
 *
 *  - first_human_prompt_v1: hash(sanitized first prompt). Stable across
 *    fork/resume because the user's first prompt doesn't change.
 *  - lineage_prefix_v1: hash(firstUuid + ":" + firstParentUuid). Stable
 *    across the same logical session even when Claude renames the jsonl.
 *
 * Returns `{ first_human_prompt_v1: null, lineage_prefix_v1: null }` when
 * the transcript is unavailable or insufficient.
 */
function computeFingerprints(transcriptMeta) {
  const out = { first_human_prompt_v1: null, lineage_prefix_v1: null };
  if (!transcriptMeta) return out;

  if (typeof transcriptMeta.firstHumanPromptRaw === 'string' &&
      transcriptMeta.firstHumanPromptRaw.length > 0) {
    const sanitized = sanitizeFirstPrompt(transcriptMeta.firstHumanPromptRaw);
    if (sanitized.length > 0) {
      out.first_human_prompt_v1 = sha256Prefix(sanitized);
    }
  }

  if (typeof transcriptMeta.firstUuid === 'string' && transcriptMeta.firstUuid.length > 0) {
    // Resume sessions have a non-null firstParentUuid; fresh sessions have
    // null. The combined hash makes both shapes uniquely identifiable.
    const parent = typeof transcriptMeta.firstParentUuid === 'string'
      ? transcriptMeta.firstParentUuid
      : '';
    out.lineage_prefix_v1 = sha256Prefix(`${transcriptMeta.firstUuid}:${parent}`);
  }
  return out;
}

function sha256Prefix(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
