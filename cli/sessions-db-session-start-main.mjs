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
 *  1. cwd-gate: bail on any cwd whose nearest CLAUDE.md does not declare a
 *     "Druumen Workspace". No event written.
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
 * cwd discipline: every storage call passes `{ root: storageRoot }` so the
 * events.jsonl + projection cache + lock file all anchor on the project
 * cwd (resolved via CLAUDE.md walk + git common-dir), NOT on the random
 * `process.cwd()` Claude Code happened to spawn the hook from.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  listTranscriptFiles,
  parseTranscriptFile,
  workspaceHashFromCwd,
} from '../lib/transcript.mjs';
import { sanitizeFirstPrompt } from '../lib/sanitize.mjs';
import {
  recordSessionSeen,
} from '../lib/storage.mjs';
import { gitContext } from '../lib/git-context.mjs';

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

  // (3) cwd-gate. We walk up from cwd looking for a CLAUDE.md that contains
  // the "Druumen Workspace" sentinel. Any other repo (admin, blog, a random
  // scratch dir) bails silently.
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

  // (5) Resolve the storage root. Prefer the worktree root (so different
  // worktrees of the same repo each accumulate their own events.jsonl) and
  // fall back to the gated cwd. NEVER fall back to process.cwd() — see (2).
  const storageRoot = gitCtx.worktreePath || cwd;

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
  // Every storage path is anchored on `storageRoot` — events.jsonl,
  // projection cache, and lock file all land in <storageRoot>/tickets/_logs/.
  // This is the cwd-plumb-through fix: process.cwd() is NEVER read by
  // storage when called this way.
  try {
    await recordSessionSeen({
      claudeSessionId,
      root: storageRoot,
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

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers (unit-tested via the hook script's own integration tests rather than
// individually so we keep them private to this entry point).
// ---------------------------------------------------------------------------

/**
 * Read a single JSON object from stdin within `timeoutMs`. Returns null on
 * timeout, empty stdin, or invalid JSON. Never throws.
 */
function readStdinJson({ timeoutMs }) {
  return new Promise((resolve) => {
    // Detached / non-piped stdin (e.g. terminal): isTTY is true. Don't even
    // bother waiting.
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      if (chunks.length === 0) {
        finish(null);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (text.length === 0) {
          finish(null);
          return;
        }
        finish(JSON.parse(text));
      } catch {
        finish(null);
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/**
 * Walk up from `cwd` looking for a CLAUDE.md whose body contains the
 * "Druumen Workspace" sentinel. Bounded to 12 ancestors so a runaway loop
 * (e.g. weird filesystem mount) cannot stall us.
 *
 * Returns true when sentinel found, false otherwise (incl. read errors).
 */
function isDruumenWorkspace(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'CLAUDE.md');
    if (existsSync(candidate)) {
      try {
        // We only need the first ~8KB to find the sentinel; CLAUDE.md is
        // typically short, so reading the whole file is fine.
        const body = readFileSync(candidate, 'utf8');
        if (body.includes('Druumen Workspace')) return true;
      } catch {
        // unreadable — keep walking up just in case there's a higher one.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Resolve the claude transcript jsonl path. Layered:
 *  1. explicit hook payload — trust it as long as the file actually exists.
 *  2. canonical path: ~/.claude/projects/<hash>/<claudeSessionId>.jsonl.
 *  3. fallback: newest jsonl in the workspace's claude projects dir (Claude
 *     Code occasionally lands transcripts under a slightly different filename
 *     during fork/resume — newest-by-mtime is the right tie-breaker).
 *
 * Returns null when nothing usable is found.
 */
function locateTranscript({ explicit, cwd, claudeSessionId }) {
  if (explicit && existsSync(explicit)) return explicit;

  // Canonical path computation requires an absolute cwd; we only walk this
  // path when it is.
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  let hash;
  try {
    hash = workspaceHashFromCwd(cwd);
  } catch {
    return null;
  }

  const canonical = join(
    process.env.HOME || '',
    '.claude',
    'projects',
    hash,
    `${claudeSessionId}.jsonl`,
  );
  if (existsSync(canonical)) return canonical;

  // Fallback: newest jsonl in the workspace dir. listTranscriptFiles already
  // sorts by mtime descending so the head of the list is the most-recent.
  let files;
  try {
    files = listTranscriptFiles(hash);
  } catch {
    return null;
  }
  return files.length > 0 ? files[0] : null;
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

function pickString(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Cheap UUID-shape validator. We don't want to lock ourselves to v4-only or
 * v7-only since Claude Code's session_id format may evolve, but we DO want to
 * reject obvious junk (empty / control chars / whitespace) that would corrupt
 * the events.jsonl line.
 */
function looksLikeUuid(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Privacy opt-out predicate for `DRUUMEN_SESSIONS_DB_STORE_PREVIEW`.
 *
 * Returns true ONLY for the literal opt-out values `'0'` and `'false'`
 * (case-insensitive, after trim). Everything else — unset, empty string,
 * `'1'`, `'true'`, `'yes'`, garbage — keeps the default-on behavior.
 *
 * Why this asymmetric shape? The default is preview-stored (backward compat
 * with 0.1.0-dev) and we want a typo in the env var to fail SAFE: an
 * operator who intends to opt out but mistypes (e.g. sets `=False` and
 * trusts case-insensitivity) gets opt-out, but a typo like `=fals` or
 * `=disabled` keeps the default. Treating only the two canonical strings
 * as off-signals makes the gate predictable; cockpit's Setup Wizard always
 * writes one of the two canonical values when the user unticks the box.
 */
function isPreviewDisabled(envValue) {
  if (typeof envValue !== 'string') return false;
  const v = envValue.trim().toLowerCase();
  return v === '0' || v === 'false';
}
