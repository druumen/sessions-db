/**
 * Pending-session staging area.
 *
 * ## Why this module exists
 *
 * `SessionStart` fires when a Claude Code process comes up — which is NOT the
 * same thing as a human starting a session. Claude Code 2.1.x keeps a daemon
 * warm-pool (`claude bg-spare` / `bg-pty-host`) and the IDE panel spawns its
 * own processes; every one of those mints a `session_id` and fires the hook,
 * and nobody ever types into most of them. Measured on the reference machine:
 * of 13 records created in one day, 11 were processes that never received a
 * single prompt. Across the whole database, 144 of 623 records (23%) are
 * sessions that never spoke and never will.
 *
 * Because the event log is append-only and has no delete op, every one of
 * those was permanent. The fix is not to delete them afterwards (that is what
 * `prune` is for, and it only exists to clean up the historical mess) — it is
 * to stop writing them in the first place.
 *
 * ## The design: defer, don't mark
 *
 * Two options were on the table:
 *
 *   A. **Pending area** (this module) — SessionStart writes a throwaway file;
 *      only the first `UserPromptSubmit` promotes it into a real
 *      `session_seen` event.
 *   B. **Provisional flag** — SessionStart writes `session_seen` as before but
 *      with `provisional: true`, cleared on first prompt; readers filter.
 *
 * A was chosen. The deciding argument is the lock, not the schema:
 *
 *   - `recordSessionSeen` holds the projection lock across
 *     load → resolveIdentity → append → apply → save. On a real database
 *     (623 sessions / 1.35 MB projection) that critical section measures
 *     ~33 ms p95, and it is the ONLY writer contended by concurrent hooks.
 *     Option A removes the lock acquisition entirely for the ghost case — a
 *     deferred SessionStart writes one small file and never touches the lock,
 *     the projection, or events.jsonl. Warm-pool spawns stop competing for
 *     the lock with sessions that are actually working. Option B keeps every
 *     ghost inside the critical section and adds a second lock cycle later to
 *     clear the flag, i.e. it makes contention strictly worse.
 *   - Option B also leaves the garbage in the SSoT forever, so `prune` would
 *     still be needed for steady-state (not just history) and every reader
 *     would need to know about the flag. Option A keeps the invariant
 *     "everything in the projection is a session someone actually used".
 *
 * The cost of A is this module: one extra directory, a promotion step, and a
 * GC for pending files whose session never spoke. All three are cheap, and
 * none of them can corrupt the SSoT — a lost pending file degrades to exactly
 * the pre-existing behaviour (the session gets recorded on its first prompt,
 * with `created_at` set to that moment instead of to process start).
 *
 * ⚠ That last sentence is a claim about the PROMOTER, not about this module,
 * and for one release it was false: the prompt hook exited without writing
 * anything when it found neither a pending record nor an existing session, so
 * a lost pending file meant a lost session — permanently, since every later
 * prompt took the same path. It is implemented in
 * `cli/sessions-db-user-prompt-main.mjs` step (9a), and pinned by tests named
 * after the two ways the file goes missing (deleted / GC'd). Anything here
 * that reasons "the pending file is disposable" depends on that code path
 * existing; do not weaken one without the other.
 *
 * ## Layout
 *
 *   <storage-root>/sessions-db-pending/<claude_session_id>.json
 *
 * One file per session id, so two hooks for different sessions never touch
 * the same path and no lock is needed. Writes are atomic (tmp + rename).
 * The record is intentionally small and self-contained: everything the
 * promoter needs to synthesise the `session_seen` it would have written at
 * SessionStart time.
 *
 * Zero new npm deps: `node:fs`, `node:path`.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { storageDir } from './storage.mjs';

/** Directory name for the staging area, relative to the storage root. */
export const PENDING_DIRNAME = 'sessions-db-pending';

/**
 * Default max age for a pending record before GC reclaims it (24 h).
 *
 * Rationale: a pending file is only useful until its session's first prompt.
 * A session that has been open for a day without a single prompt is a
 * warm-pool process or an abandoned window — promoting it later would date
 * the record to a `created_at` a day in the past, which is worse than simply
 * recording it at first-prompt time. 24 h is deliberately generous: the cost
 * of keeping a stale 200-byte file is nil, the cost of dropping a real
 * session's start time is a wrong `created_at`.
 *
 * The "which is worse than simply recording it at first-prompt time" clause is
 * load-bearing and rests entirely on the prompt hook recording a session it
 * cannot find (step (9a) there). Without that, GC here does not cost a start
 * time — it costs the whole session, and "left the tab open on Friday, typed
 * on Monday" is enough to trigger it.
 */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * UUID shape guard. Pending filenames are built from a claude_session_id that
 * ultimately comes from hook stdin, so it is untrusted input joined into a
 * path. Rejecting anything that is not a canonical UUID makes `../../etc`
 * and friends unrepresentable — this is a path-traversal gate, not a
 * politeness check, and every entry point in this module runs it.
 */
function isUuidLike(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Absolute path of the pending directory for a storage opts shape.
 *
 * @param {object} [opts] same shape accepted by storage.mjs
 * @returns {string}
 */
export function pendingDir(opts = {}) {
  return join(storageDir(opts), PENDING_DIRNAME);
}

/**
 * Absolute path of one pending record.
 *
 * @param {string} claudeSessionId
 * @param {object} [opts]
 * @returns {string|null} null when the id is not UUID-shaped
 */
export function pendingPath(claudeSessionId, opts = {}) {
  if (!isUuidLike(claudeSessionId)) return null;
  return join(pendingDir(opts), `${claudeSessionId}.json`);
}

/**
 * @typedef {Object} PendingRecord
 * @property {string} claude_session_id
 * @property {string} observed_at        ISO ts of the deferred SessionStart —
 *                                       becomes the promoted record's created_at
 * @property {string|null} cwd
 * @property {string|null} branch_at_start
 * @property {string|null} head_at_start
 * @property {string|null} worktree_path_observed
 * @property {string|null} worktree_realpath
 * @property {string|null} worktree_registry_name
 * @property {string|null} git_common_dir
 * @property {string|null} source        Claude Code's SessionStart `source`
 * @property {number} schema             Pending-record schema version (1)
 */

/**
 * Write (or overwrite) a pending record. Atomic: tmp file + fsync + rename,
 * same discipline as the projection cache, so a crashed hook can never leave
 * a half-written JSON that the promoter would then fail to parse.
 *
 * Overwrite-on-repeat is intentional: SessionStart can fire more than once
 * for the same session id (we observe pairs ~30 ms apart in the wild), and
 * the latest observation is the one worth keeping.
 *
 * Never throws — returns false on any failure. A hook that cannot stage a
 * pending record must still exit 0; the only consequence is a `created_at`
 * that starts at first prompt instead of at process start.
 *
 * @param {PendingRecord} record
 * @param {object} [opts]
 * @returns {boolean} true when the file is on disk
 */
export function writePending(record, opts = {}) {
  if (!record || typeof record !== 'object') return false;
  const path = pendingPath(record.claude_session_id, opts);
  if (path === null) return false;

  const tmpPath = `${path}.tmp.${process.pid}`;
  try {
    mkdirSync(pendingDir(opts), { recursive: true });
    const body = JSON.stringify({ schema: 1, ...record });
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, path);
    return true;
  } catch {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    return false;
  }
}

/**
 * Read one pending record. Returns null when absent, unparseable, or not
 * shaped like a pending record. Never throws.
 *
 * @param {string} claudeSessionId
 * @param {object} [opts]
 * @returns {PendingRecord|null}
 */
export function readPending(claudeSessionId, opts = {}) {
  const path = pendingPath(claudeSessionId, opts);
  if (path === null) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.claude_session_id !== claudeSessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete one pending record. Idempotent; never throws.
 *
 * @param {string} claudeSessionId
 * @param {object} [opts]
 * @returns {boolean} true when a file was removed
 */
export function deletePending(claudeSessionId, opts = {}) {
  const path = pendingPath(claudeSessionId, opts);
  if (path === null) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List pending records with their mtimes. Never throws; a missing directory
 * is an empty list.
 *
 * @param {object} [opts]
 * @returns {{ claude_session_id: string, path: string, mtimeMs: number }[]}
 */
export function listPending(opts = {}) {
  const dir = pendingDir(opts);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const csid = e.name.slice(0, -'.json'.length);
    if (!isUuidLike(csid)) continue; // ignore tmp debris and foreign files
    const path = join(dir, e.name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    out.push({ claude_session_id: csid, path, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * Filename of the promoter liveness marker inside the pending directory.
 * Leading dot so `listPending`'s UUID filter skips it for free.
 */
export const PROMOTER_MARKER = '.promoter';

/**
 * How long a promoter marker stays trusted (30 days).
 *
 * Long on purpose. The marker answers "is the UserPromptSubmit hook wired up
 * on this machine?", which is a property of the user's configuration, not of
 * recent activity. Someone who does not open this workspace for three weeks
 * must not have deferral silently switch off underneath them.
 */
export const PROMOTER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Rewrite the marker at most this often (1 h) so a per-prompt hook is cheap. */
const PROMOTER_REFRESH_MS = 60 * 60 * 1000;

/**
 * Secondary liveness signal — thresholds.
 *
 * The 30-day marker window above is right for its stated question ("is the
 * hook configured?") but it opens a 30-day blind spot for the failure it
 * exists to catch: a user who removes the `UserPromptSubmit` registration
 * while staying on 0.2.0 keeps a marker that is still "fresh" by that
 * standard, so SessionStart keeps deferring and NOTHING promotes — sessions
 * are staged, expire at `PENDING_MAX_AGE_MS`, and are lost. Silently. For a
 * month. That is precisely the failure the marker was introduced to prevent.
 *
 * So the marker is cross-examined once it goes stale: a promoter that is
 * running refreshes it at least hourly (see `PROMOTER_REFRESH_MS`), therefore
 * a marker untouched for `PROMOTER_STALE_AFTER_MS` while sessions kept being
 * staged behind it is evidence of a backlog nobody is draining.
 *
 * Thresholds are deliberately loose, because a false positive costs ghost
 * records (the pre-0.2.0 behaviour) and a false negative costs sessions.
 * Ghost stagings alone do NOT trip it — an idle machine's warm-pool spawns
 * are staged and never promoted in normal operation too, so the discriminator
 * is that they piled up AFTER the marker went quiet.
 */
export const PROMOTER_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Staged records newer than the marker needed before we stop trusting it. */
export const PROMOTER_BACKLOG_MIN_COUNT = 3;
/** ...and each must be at least this old — a fresh one may promote any second. */
export const PROMOTER_BACKLOG_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Record that a promoter (the `UserPromptSubmit` hook) ran against this
 * storage root.
 *
 * ## Why liveness detection exists at all
 *
 * Deferral is only safe if something will later promote what was deferred. The
 * two hooks are registered independently in `~/.claude/settings.json`, so a
 * user who upgrades the package without adding the `UserPromptSubmit` entry
 * would get a `SessionStart` that defers every new session and nothing that
 * ever promotes one — the pending records would expire and NOTHING would be
 * recorded. That failure mode is silent and strictly worse than the ghost
 * records deferral exists to prevent.
 *
 * So `SessionStart` defers only when it can see evidence that a promoter is
 * alive, and this is that evidence. Absent the marker, the hook falls back to
 * the pre-0.2.0 always-record behaviour: ghosts come back, but no session is
 * ever lost. Failing toward the old behaviour is the only acceptable direction.
 *
 * ## Why a marker file instead of reading settings.json
 *
 * Hook registration can live in `~/.claude/settings.json`, a project
 * `.claude/settings.json`, `.claude/settings.local.json`, or a managed
 * enterprise policy, and the shape has changed across Claude Code versions.
 * Parsing all of that is guesswork about someone else's config format. A
 * marker written by the promoter itself is direct evidence: the hook is not
 * merely configured, it demonstrably ran.
 *
 * Cost control: we `stat` first and only rewrite when the marker is missing or
 * older than an hour, so the steady-state cost on a per-prompt hook is one
 * stat.
 *
 * Never throws.
 *
 * @param {object} [opts]
 * @param {{ now?: number }} [markOpts]
 * @returns {boolean} true when the marker is present and current afterwards
 */
export function markPromoterAlive(opts = {}, markOpts = {}) {
  const now = Number.isFinite(markOpts.now) ? markOpts.now : Date.now();
  const path = join(pendingDir(opts), PROMOTER_MARKER);
  try {
    const st = statSync(path);
    if (now - st.mtimeMs < PROMOTER_REFRESH_MS) return true;
  } catch {
    // missing — fall through and create
  }
  try {
    mkdirSync(pendingDir(opts), { recursive: true });
    // Human-readable body so anyone poking at the directory can tell what this
    // is; only the mtime is load-bearing.
    writeFileSync(path, `${new Date(now).toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a promoter alive for this storage root? See `markPromoterAlive` for why
 * this gate exists and why "no" must mean "do not defer".
 *
 * Two independent ways to answer "no":
 *
 *   1. the marker is missing or older than `maxAgeMs` (30 days) — the coarse,
 *      original check;
 *   2. the marker is stale (`PROMOTER_STALE_AFTER_MS`) AND at least
 *      `PROMOTER_BACKLOG_MIN_COUNT` sessions were staged after it was last
 *      refreshed and are still sitting there unpromoted. A live promoter
 *      refreshes the marker hourly, so this combination means deferral is
 *      writing into a void.
 *
 * When (2) fires the marker is RETIRED (unlinked), not merely ignored. The
 * evidence is the pending backlog, and the backlog expires at
 * `PENDING_MAX_AGE_MS`; leaving the marker in place would make the answer
 * oscillate — distrust for a day, trust again once the evidence was GC'd,
 * losing another day of sessions before it re-accumulated. Retiring makes the
 * decision stick, and it is self-healing in the right direction: the very
 * next real prompt-hook run calls `markPromoterAlive`, recreates the marker,
 * and deferral resumes. Deleting is best-effort and never throws; if it
 * fails, the worst case is the oscillation we were avoiding, never a loss.
 *
 * @param {object} [opts]
 * @param {{ maxAgeMs?: number, now?: number, staleAfterMs?: number }} [checkOpts]
 * @returns {boolean}
 */
export function isPromoterAlive(opts = {}, checkOpts = {}) {
  const maxAgeMs = Number.isFinite(checkOpts.maxAgeMs) && checkOpts.maxAgeMs > 0
    ? checkOpts.maxAgeMs
    : PROMOTER_MAX_AGE_MS;
  const staleAfterMs = Number.isFinite(checkOpts.staleAfterMs) && checkOpts.staleAfterMs > 0
    ? checkOpts.staleAfterMs
    : PROMOTER_STALE_AFTER_MS;
  const now = Number.isFinite(checkOpts.now) ? checkOpts.now : Date.now();
  const markerPath = join(pendingDir(opts), PROMOTER_MARKER);

  let st;
  try {
    st = statSync(markerPath);
  } catch {
    return false;
  }
  const markerAgeMs = now - st.mtimeMs;
  if (markerAgeMs > maxAgeMs) return false;

  // Fast path: a marker refreshed within the staleness window is a promoter
  // that demonstrably ran recently. One stat, no readdir — this is the steady
  // state on every machine where both hooks are wired up.
  if (markerAgeMs <= staleAfterMs) return true;

  if (!hasUnpromotedBacklog(opts, { now, sinceMs: st.mtimeMs })) return true;

  try {
    unlinkSync(markerPath);
  } catch {
    // best-effort — the answer below is still "no" for this call
  }
  return false;
}

/**
 * Are there staged sessions that appeared after `sinceMs` and have been
 * waiting long enough that a live promoter would have drained them?
 *
 * Only counts records staged AFTER the marker's last refresh: a healthy
 * machine always has some unpromoted stagings (warm-pool spawns are exactly
 * that), so their mere existence proves nothing. What proves something is
 * that they accumulated during a period in which no prompt hook ran.
 *
 * @param {object} [opts]
 * @param {{ now: number, sinceMs: number }} args
 * @returns {boolean}
 */
function hasUnpromotedBacklog(opts, { now, sinceMs }) {
  let count = 0;
  for (const entry of listPending(opts)) {
    if (entry.mtimeMs <= sinceMs) continue;
    if (now - entry.mtimeMs < PROMOTER_BACKLOG_MIN_AGE_MS) continue;
    count += 1;
    if (count >= PROMOTER_BACKLOG_MIN_COUNT) return true;
  }
  return false;
}

/**
 * Garbage-collect pending records older than `maxAgeMs`.
 *
 * Called opportunistically from the SessionStart hook (the same event that
 * creates pending files), so the area is self-limiting without a cron: every
 * new session pays one bounded readdir and reclaims whatever expired. There
 * is deliberately no lock — deleting a file that another process is
 * simultaneously promoting is harmless, because promotion reads the record
 * into memory first and treats a missing file as "nothing staged".
 *
 * @param {object} [opts]
 * @param {{ maxAgeMs?: number, now?: number }} [sweepOpts]
 * @returns {{ removed: number, kept: number }}
 */
export function sweepPending(opts = {}, sweepOpts = {}) {
  const maxAgeMs = Number.isFinite(sweepOpts.maxAgeMs) && sweepOpts.maxAgeMs > 0
    ? sweepOpts.maxAgeMs
    : PENDING_MAX_AGE_MS;
  const now = Number.isFinite(sweepOpts.now) ? sweepOpts.now : Date.now();

  let removed = 0;
  let kept = 0;
  for (const entry of listPending(opts)) {
    if (now - entry.mtimeMs > maxAgeMs) {
      try {
        unlinkSync(entry.path);
        removed += 1;
      } catch {
        kept += 1;
      }
    } else {
      kept += 1;
    }
  }
  return { removed, kept };
}
