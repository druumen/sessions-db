/**
 * sessions-db UserPromptSubmit hook — real main.
 *
 * ## Why this hook exists
 *
 * Until now `SessionStart` was the ONLY writer, and it runs strictly before
 * the user has said anything. That single fact produced three separate
 * user-visible defects:
 *
 *   - `first_prompt_preview` was permanently null for any session that was
 *     never resumed. Measured on the reference database: of 189 sessions
 *     whose identity resolved as `minted` (opened once, never resumed), only
 *     4 ever got a preview. The transcript `.jsonl` does not exist yet when
 *     SessionStart fires, so the hook is *structurally* incapable of knowing
 *     the first prompt.
 *   - `last_progress_at` was frozen at `created_at` for the same population,
 *     so "sort by most recent activity" actually sorted by "who happened to
 *     get resumed". A session someone had been working in for three hours
 *     sank below a zombie that was resumed once.
 *   - `branch_current` never moved off `branch_at_start`, even though a
 *     multi-hour session routinely changes branch.
 *
 * This hook fires on every prompt submission, which is exactly when all three
 * facts become knowable. It also drives the promotion half of the pending-area
 * design (see `lib/pending.mjs`): a session that never reaches this hook never
 * becomes a database record at all.
 *
 * ## Safety contract (identical to SessionStart, item for item)
 *
 *  1. cwd-gate — `isDruumenWorkspace` (shared, `lib/hook-common.mjs`).
 *  2. time budget — bootstrap's `setTimeout(1000).unref()`; every sub-probe
 *     is async and bounded so the timer can actually fire. Target p95 200 ms.
 *  3. silent stderr — nothing is ever written to stderr by us.
 *  4. exit 0 always — every path, including gate rejection and lock timeout.
 *  5. kill-switch — `DRUUMEN_SESSIONS_DB_DISABLED=1` (bootstrap shim).
 *  6. shared git probe — `lib/git-context.mjs`, via `gitContextFast`.
 *
 * ## Budget: what was measured, and what was cut
 *
 * Measured on the reference workspace (warm cache, real 623-session database):
 *
 *   full 6-probe gitContext .................. p50 73 ms   p95 109 ms
 *   two spawns (branch + rev-parse HEAD) ..... p50 16 ms   p95  38 ms
 *   ONE spawn (rev-parse --show-toplevel
 *     HEAD --abbrev-ref HEAD) ................ p50  6 ms   p95   6 ms
 *   projection read-modify-write under lock .. p50 17 ms   p95  33 ms
 *   node cold start .......................... ~20 ms
 *
 * Copying SessionStart's six probes would have spent more than half the
 * budget re-measuring facts that cannot change mid-session (worktree
 * realpath, git common dir, dev-offload registry name). So this hook probes
 * exactly the two things that DO drift — branch and HEAD — plus the worktree
 * root it needs to anchor storage, and gets all three from a single spawn.
 *
 * The transcript is not read at all: `UserPromptSubmit` hands us the prompt
 * text directly, which is both cheaper and more correct than waiting for
 * Claude Code to flush it to the transcript.
 */

import { createHash } from 'node:crypto';

import { gitContextFast } from '../lib/git-context.mjs';
import {
  isDruumenWorkspace,
  isPreviewDisabled,
  looksLikeUuid,
  pickString,
  readStdinJson,
  resolveStorageTarget,
} from '../lib/hook-common.mjs';
import { deletePending, markPromoterAlive, readPending } from '../lib/pending.mjs';
import { sanitizeFirstPrompt } from '../lib/sanitize.mjs';
import {
  loadProjection,
  newEvent,
  recordSessionSeen,
  tryUpdateProjection,
} from '../lib/storage.mjs';

// ---------------------------------------------------------------------------
// Top-level safety wrapper. Any unhandled rejection in main() exits 0 silently
// — never throws, never console.errors. The bootstrap shim has its own
// uncaughtException handler as a final backstop.
// ---------------------------------------------------------------------------

main().catch(() => process.exit(0));

async function main() {
  // (1) Read hook payload from stdin. `UserPromptSubmit` delivers
  // `{ session_id, transcript_path, cwd, prompt, hook_event_name }`.
  const input = await readStdinJson({ timeoutMs: 100 });

  // (2) Resolve cwd — explicit input wins, then CLAUDE_PROJECT_DIR, then our
  // own process.cwd(). Once committed to here, `process.cwd()` is never read
  // again; every downstream path anchors on this value.
  const cwd = pickString(input?.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  // (3) cwd-gate. Same acceptance rule as SessionStart (shared helper): a
  // CLAUDE.md "Druumen Workspace" sentinel, or a pre-initialized storage dir,
  // at cwd or any ancestor. Anything else bails silently.
  if (!isDruumenWorkspace(cwd)) {
    process.exit(0);
  }

  // (4) claude_session_id — required. Without it we cannot correlate this
  // prompt with any session, and minting an identity from a prompt alone
  // would create exactly the kind of orphan record this whole change exists
  // to eliminate.
  const claudeSessionId = pickString(input?.session_id) ||
    process.env.CLAUDE_SESSION_ID ||
    null;
  if (!claudeSessionId || !looksLikeUuid(claudeSessionId)) {
    process.exit(0);
  }

  // (5) git context — ONE spawn (see the budget note in the file header).
  // A short budget: on a wedged repo we would rather write the progress event
  // without branch/HEAD than miss the heartbeat entirely, so every git-derived
  // field below is optional. `not_a_repo` is NOT fatal here (unlike
  // SessionStart): the session already exists or is staged, and its heartbeat
  // is worth recording even if the user has since cd'd somewhere odd.
  let gitCtx;
  try {
    gitCtx = await gitContextFast({ cwd, totalBudgetMs: 400 });
  } catch {
    gitCtx = { cwd, worktreePath: null, branch: null, head: null, status: 'error', errors: [] };
  }

  // (6) Storage target. Anchored on the git worktree root when we have one,
  // else the gated cwd. Shared resolver — SessionStart MUST land on the same
  // directory or promotion could never find the pending record.
  const workspaceRoot = gitCtx.worktreePath || cwd;
  const recordTargetOpts = resolveStorageTarget({ workspaceRoot });

  // (6b) Announce that a promoter is alive for this storage root. SessionStart
  // defers a brand-new session ONLY when it can see this marker — otherwise a
  // user who upgraded the package without registering this hook would get
  // deferral with nothing to promote, and no sessions recorded at all. Cheap:
  // one stat in the steady state, one write per hour. See `markPromoterAlive`.
  //
  // Deliberately BEFORE the gate on whether we have anything to write: even a
  // prompt for a session we end up ignoring proves this hook is wired up.
  try {
    markPromoterAlive(recordTargetOpts);
  } catch {
    // best-effort — exit-0 contract. Worst case SessionStart keeps recording
    // eagerly, which is the pre-0.2.0 behaviour.
  }

  // (7) The prompt itself. This is the payload field that makes the whole
  // hook worthwhile — no transcript read, no waiting for a flush.
  //
  // Privacy opt-out (`DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0|false`) suppresses
  // the human-readable preview but NOT the fingerprint: identity
  // reconciliation depends on `first_human_prompt_v1`, and — since 0.2.0 —
  // so does `prune`, which treats a non-null fingerprint as proof that a real
  // conversation happened. Stripping it would make opt-out users' sessions
  // look like ghosts.
  const rawPrompt = pickString(input?.prompt);
  const sanitized = rawPrompt ? sanitizeFirstPrompt(rawPrompt) : '';
  const storeFirstPrompt = !isPreviewDisabled(process.env.DRUUMEN_SESSIONS_DB_STORE_PREVIEW);
  const firstPromptPreview = storeFirstPrompt && sanitized.length > 0 ? sanitized : null;
  const promptFingerprint = sanitized.length > 0 ? sha256Prefix(sanitized) : null;

  // (8) Promotion path. If SessionStart staged this session in the pending
  // area, this is its first prompt — turn it into a real `session_seen` now,
  // replaying the git context captured at session start so the record is
  // indistinguishable from what the old always-write behaviour would have
  // produced, except that it only exists because someone actually typed.
  const pending = readPending(claudeSessionId, recordTargetOpts);
  if (pending) {
    const promoted = await promote({
      claudeSessionId,
      pending,
      cwd,
      gitCtx,
      firstPromptPreview,
      promptFingerprint,
      recordTargetOpts,
    });
    if (promoted) {
      // Only drop the staged record once the event is durable. If the write
      // failed we deliberately keep the pending file so the NEXT prompt gets
      // another chance at promotion with the correct `created_at`.
      deletePending(claudeSessionId, recordTargetOpts);
      process.exit(0);
    }
    // Promotion failed (lock timeout, disk). Fall through to the heartbeat
    // path — it targets whatever stable_id already exists and is a no-op when
    // none does, so we never fabricate identity from a failed promotion.
  }

  // (9) Heartbeat path — the steady state, second prompt onward.
  //
  // We resolve the stable_id by csid index rather than calling
  // recordSessionSeen, for two reasons. First, cost: recordSessionSeen runs
  // the full three-priority identity chain (lineage + fingerprint
  // corroborators over every session in the projection) which is far more
  // work than a heartbeat needs. Second, and more importantly, semantics: a
  // heartbeat must NEVER mint. If we cannot find the session, the right
  // answer is to write nothing — a prompt from a session we have no record of
  // is either a workspace we are not tracking or a race with SessionStart,
  // and inventing a record for it would reintroduce orphans through a
  // different door.
  const stableId = await findStableIdByCsid(claudeSessionId, recordTargetOpts);
  if (!stableId) {
    process.exit(0);
  }

  const event = newEvent({
    op: 'session_progress',
    stable_id: stableId,
    payload: {
      claude_session_id: claudeSessionId,
      // First-write-wins in the reducer — sending it on every prompt is safe
      // and covers the case where the promotion path was skipped (session
      // predates this hook, e.g. an in-flight session at upgrade time).
      first_prompt_preview: firstPromptPreview,
      branch_current: gitCtx.branch,
      head_last_seen: gitCtx.head,
      worktree_path_observed: gitCtx.worktreePath || cwd,
      cwd,
    },
  });

  try {
    // Holds the lock across append + apply + save so concurrent hooks cannot
    // clobber each other's derived state.
    await tryUpdateProjection(event, { ...recordTargetOpts, lockTimeoutMs: 800 });
  } catch {
    // exit-0 contract. The SSoT-first ordering inside tryUpdateProjection
    // means a projection failure still leaves a durable event for rebuild.
  }

  process.exit(0);
}

/**
 * Turn a staged pending record into a real `session_seen` event.
 *
 * The payload is assembled from BOTH observations: the git/worktree context
 * captured at SessionStart (replayed out of the pending file — it describes
 * where the session began) and the prompt we just received (which SessionStart
 * could not possibly have known). `created_at` carries the deferred
 * observation time so the record dates from process start, not from the first
 * prompt; the reducer takes the earlier of the two (see `reduceSessionSeen`).
 *
 * Runs through `recordSessionSeen` rather than a raw event append so the
 * promotion goes through the same atomic identity transaction as any other
 * `session_seen`: if a concurrent SessionStart already recorded this session
 * (resume race), the csid index resolves to the existing stable_id and the
 * promotion merges into it instead of splitting identity.
 *
 * @returns {Promise<boolean>} true when the event is durable
 */
async function promote({
  claudeSessionId,
  pending,
  cwd,
  gitCtx,
  firstPromptPreview,
  promptFingerprint,
  recordTargetOpts,
}) {
  const fingerprints = {
    first_human_prompt_v1: promptFingerprint,
    // lineage_prefix_v1 needs transcript uuids, which we deliberately do not
    // read here. It stays null until a later SessionStart (resume / compact)
    // parses the transcript and fills it in — a first-write-wins field, so
    // that later observation lands cleanly.
    lineage_prefix_v1: null,
  };

  try {
    const result = await recordSessionSeen({
      claudeSessionId,
      ...recordTargetOpts,
      lockTimeoutMs: 800,
      transcriptMeta: null,
      gitContext: gitCtx,
      cwd,
      fingerprints,
      // The preview is already gated by the privacy env var above; pass it
      // through as-is rather than re-deriving the policy here.
      storeFirstPrompt: true,
      payloadBuilder: () => ({
        claude_session_id: claudeSessionId,
        // Earliest-wins in the reducer — this is the whole reason the pending
        // area stores `observed_at`.
        created_at: pickString(pending.observed_at) || undefined,
        // Session-start facts, replayed from the pending record.
        branch_at_start: pending.branch_at_start ?? null,
        head_at_start: pending.head_at_start ?? null,
        worktree_realpath: pending.worktree_realpath ?? null,
        worktree_registry_name: pending.worktree_registry_name ?? null,
        git_common_dir: pending.git_common_dir ?? null,
        // Current facts, from this turn's probe (branch may already have
        // moved between session start and first prompt).
        branch_current: gitCtx.branch ?? pending.branch_at_start ?? null,
        head_last_seen: gitCtx.head ?? pending.head_at_start ?? null,
        worktree_path_observed: gitCtx.worktreePath || pending.worktree_path_observed || cwd,
        // No transcript was read — an explicit null keeps the reducer from
        // pushing an entry into transcript_files[].
        transcript_file: null,
        fingerprints,
        first_prompt_preview: firstPromptPreview,
        cwd: pickString(pending.cwd) || cwd,
        promoted_from_pending: true,
      }),
    });
    return !!(result && result.ok);
  } catch {
    return false;
  }
}

/**
 * Reverse-lookup a stable_id from a claude_session_id.
 *
 * Unlocked read: the heartbeat is advisory, and the failure mode of a stale
 * read is "we skip one heartbeat", which the next prompt repairs. Taking the
 * projection lock twice per prompt (once to look up, once to write) would
 * double this hook's contention for no correctness gain.
 *
 * Returns null on miss, corrupt projection, or any read failure — all of
 * which mean "write nothing".
 */
async function findStableIdByCsid(claudeSessionId, recordTargetOpts) {
  try {
    const projection = await loadProjection(recordTargetOpts);
    const sessions = (projection && projection.sessions) || {};
    for (const [stableId, s] of Object.entries(sessions)) {
      if (s && Array.isArray(s.claude_session_ids) &&
          s.claude_session_ids.includes(claudeSessionId)) {
        return stableId;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function sha256Prefix(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
