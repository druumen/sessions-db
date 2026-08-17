/**
 * Ghost-record pruning.
 *
 * ## What a ghost is
 *
 * A record for a Claude Code process that came up, fired `SessionStart`, and
 * was never spoken to. Claude Code 2.1.x keeps a daemon warm-pool and the IDE
 * panel spawns its own processes; each mints a session id and trips the hook.
 * Since the event log has no delete op, every one of them was permanent.
 *
 * The `UserPromptSubmit` hook + pending area (see `lib/pending.mjs`) stop new
 * ghosts from being written. This module cleans up the ones already on disk.
 *
 * ## The judgement call
 *
 * Deleting session history is irreversible from a user's point of view, so
 * the criteria are deliberately over-conservative: a record is only a
 * candidate when EVERY signal that a human ever touched it is absent. False
 * negatives (a ghost survives) cost one stale row; false positives (a real
 * session is deleted) cost work someone did. The asymmetry is the whole
 * design.
 *
 * A record is prunable only when all of the following hold:
 *
 *   1. `first_prompt_preview` is empty — nobody ever typed.
 *   2. Both fingerprints are null. **This is not redundant with (1).** Users
 *      who set `DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0` (the privacy opt-out)
 *      have `first_prompt_preview: null` on *every* record they own, real or
 *      not — criterion (1) alone would make their entire history prunable
 *      once transcripts rotate off disk. Fingerprints are explicitly NOT
 *      stripped by that opt-out (identity reconciliation depends on them), so
 *      a non-null fingerprint proves a transcript with real content existed.
 *      This criterion is what makes prune safe for privacy-opt-out users.
 *   3. `ai_title` is empty — Claude Code only emits `ai-title` records after
 *      there is a conversation to title.
 *   4. No transcript on disk for ANY of the record's claude_session_ids.
 *   5. `created_at` is older than the threshold (default 1 h) — never touch a
 *      session that was opened minutes ago and simply has not been typed into
 *      yet.
 *   6. No operator intent attached: no alias, no parent_session_id, not
 *      referenced as a parent by another record, no linked tasks/projects,
 *      and `outcome === 'open'` (a closed session was deliberately closed).
 *
 * Measured against the reference database (623 records, 304 transcripts on
 * disk): 144 candidates, of which ZERO carried an ai_title, a fingerprint, a
 * task/project link, a non-open outcome, or a second claude_session_id. The
 * 230 records that have a preview but no transcript on disk (real sessions
 * whose transcripts have rotated away) are all correctly spared by (1).
 *
 * ## Append-only semantics
 *
 * Pruning writes a `session_prune` event; it never rewrites events.jsonl. The
 * reducer deletes the record when it replays the tombstone, so a rebuild from
 * the SSoT reproduces the pruned state exactly, and the original observations
 * remain readable for forensics.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { acquireLock } from './lock.mjs';
import { applyEvent } from './projection.mjs';
import {
  appendEvent,
  loadProjection,
  lockPathFor,
  newEvent,
  saveProjection,
} from './storage.mjs';
import { indexTranscriptCsids, workspaceHashFromCwd } from './transcript.mjs';

/** Default age floor: never prune a record younger than this. */
export const DEFAULT_OLDER_THAN_MS = 60 * 60 * 1000;

/**
 * Parse a duration string like `30m` / `2h` / `7d` into milliseconds.
 *
 * A unit suffix is REQUIRED. A bare `--older-than 24` is ambiguous (24 what?
 * the default unit is hours, but the sweep command next door speaks days) and
 * this flag gates a delete, so guessing is the wrong trade — we reject and
 * say what we wanted instead.
 *
 * @param {string} text
 * @returns {number|null} milliseconds, or null when unparseable
 */
export function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === 's' ? 1000
    : unit === 'm' ? 60 * 1000
      : unit === 'h' ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  return value * factor;
}

/**
 * Second, targeted disk check for one record.
 *
 * `indexTranscriptCsids()` swallows per-directory read errors, so a
 * permission blip could shrink the index and make a live session look
 * transcript-less. This is the "双保险" second net the design calls for: for
 * every csid we ALSO compute the canonical path from the record's own cwd and
 * stat it directly. A hit from either path spares the record.
 *
 * @param {object} session
 * @param {Set<string>} diskCsids
 * @param {{ projectsRoot?: string }} [opts]
 * @returns {boolean}
 */
export function hasTranscriptOnDisk(session, diskCsids, opts = {}) {
  const csids = Array.isArray(session.claude_session_ids) ? session.claude_session_ids : [];
  if (csids.length === 0) return false;

  for (const csid of csids) {
    if (diskCsids.has(csid)) return true;
  }

  // Targeted fallback — canonical path derived from the record's own cwd.
  const cwd = typeof session.cwd === 'string' ? session.cwd : session.worktree_path_observed;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return false;
  let hash;
  try {
    hash = workspaceHashFromCwd(cwd);
  } catch {
    return false;
  }
  const root = opts.projectsRoot ||
    process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT ||
    join(homedir(), '.claude', 'projects');
  for (const csid of csids) {
    if (existsSync(join(root, hash, `${csid}.jsonl`))) return true;
  }
  return false;
}

/**
 * Plan a prune. Pure — all disk state arrives via `diskCsids`.
 *
 * @param {object} projection
 * @param {{
 *   diskCsids?: Set<string>,
 *   olderThanMs?: number,
 *   now?: number,
 *   projectsRoot?: string,
 * }} [opts]
 * @returns {{
 *   candidates: Array<{ stable_id: string, created_at: string, age_hours: number,
 *     claude_session_ids: string[], cwd: string|null, branch_at_start: string|null }>,
 *   scanned: number,
 *   spared: Record<string, number>,
 * }}
 */
export function computePruneCandidates(projection, opts = {}) {
  const sessions = (projection && projection.sessions) || {};
  const diskCsids = opts.diskCsids instanceof Set ? opts.diskCsids : new Set();
  const olderThanMs = Number.isFinite(opts.olderThanMs) && opts.olderThanMs > 0
    ? opts.olderThanMs
    : DEFAULT_OLDER_THAN_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  // Which records are somebody's declared parent? Computed once so the
  // per-record check is O(1) and cannot miss a child that appears later in
  // iteration order.
  const referencedAsParent = new Set();
  for (const s of Object.values(sessions)) {
    if (s && typeof s.parent_session_id === 'string' && s.parent_session_id.length > 0) {
      referencedAsParent.add(s.parent_session_id);
    }
  }

  const candidates = [];
  // Tally of which criterion spared each non-candidate (first hit wins). Not
  // load-bearing, but it is what makes `--json` output debuggable when an
  // operator asks "why didn't it pick up that obvious ghost?".
  const spared = {};
  const spare = (reason) => { spared[reason] = (spared[reason] || 0) + 1; };

  for (const [stableId, s] of Object.entries(sessions)) {
    if (!s || typeof s !== 'object') continue;

    if (s.first_prompt_preview) { spare('has_first_prompt_preview'); continue; }
    const fp = s.fingerprints || {};
    if (fp.first_human_prompt_v1 || fp.lineage_prefix_v1) { spare('has_fingerprint'); continue; }
    if (s.ai_title) { spare('has_ai_title'); continue; }
    if (s.alias) { spare('has_alias'); continue; }
    if (s.parent_session_id) { spare('has_parent'); continue; }
    if (referencedAsParent.has(stableId)) { spare('is_parent_of_another'); continue; }
    if ((Array.isArray(s.tasks) && s.tasks.length > 0) ||
        (Array.isArray(s.projects) && s.projects.length > 0)) {
      spare('has_task_or_project_link'); continue;
    }
    if (s.outcome && s.outcome !== 'open') { spare('has_outcome'); continue; }

    const createdMs = Date.parse(s.created_at);
    // An unparseable created_at means we cannot prove the record is old
    // enough. Spare it — "cannot verify" must never resolve to "delete".
    if (!Number.isFinite(createdMs)) { spare('unparseable_created_at'); continue; }
    const ageMs = now - createdMs;
    if (ageMs < olderThanMs) { spare('too_recent'); continue; }

    if (hasTranscriptOnDisk(s, diskCsids, { projectsRoot: opts.projectsRoot })) {
      spare('transcript_on_disk'); continue;
    }

    candidates.push({
      stable_id: stableId,
      created_at: s.created_at,
      age_hours: Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10,
      claude_session_ids: Array.isArray(s.claude_session_ids) ? [...s.claude_session_ids] : [],
      cwd: typeof s.cwd === 'string' ? s.cwd : null,
      branch_at_start: s.branch_at_start ?? null,
    });
  }

  // Newest first — an operator eyeballing a dry-run cares most about whether
  // anything recent got swept up.
  candidates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return { candidates, scanned: Object.keys(sessions).length, spared };
}

/**
 * Execute a prune (or plan one).
 *
 * Lock discipline: unlike every other write in `operations.mjs`, this does
 * NOT loop over `tryUpdateProjection`. That primitive takes and releases the
 * projection lock per event; at ~33 ms per cycle on a real database, 144
 * tombstones would hold-and-release for the better part of five seconds and
 * leave the projection observably half-pruned to any concurrent reader in
 * between. Instead we run ONE transaction — acquire, load, append+apply every
 * tombstone, save once, release — so the projection goes from "before" to
 * "after" in a single atomic rename with no intermediate state.
 *
 * The SSoT-first ordering of `tryUpdateProjection` is preserved per event:
 * each tombstone is appended to events.jsonl before it is applied in memory,
 * so a crash mid-batch leaves a durable log that the next rebuild folds into
 * exactly the same result.
 *
 * @param {{
 *   dryRun?: boolean,
 *   olderThanMs?: number,
 *   now?: number,
 *   reason?: string,
 *   rootPath?: string, root?: string, paths?: object,
 *   lockTimeoutMs?: number, lockRetryMs?: number,
 * }} [opts]
 * @returns {Promise<object>}
 */
export async function runPrune(opts = {}) {
  const storage = {};
  if (opts.rootPath !== undefined) storage.rootPath = opts.rootPath;
  if (opts.root !== undefined) storage.root = opts.root;
  if (opts.paths !== undefined) storage.paths = opts.paths;

  const scan = indexTranscriptCsids();

  // Plan against an unlocked read first. For a dry run that is the whole job;
  // for a real run the plan is recomputed inside the lock (below) so we never
  // delete based on a projection snapshot that changed under us.
  const preview = computePruneCandidates(await loadProjection(storage), {
    diskCsids: scan.csids,
    olderThanMs: opts.olderThanMs,
    now: opts.now,
  });

  if (opts.dryRun !== false) {
    return {
      ok: true,
      dryRun: true,
      candidates: preview.candidates,
      scanned: preview.scanned,
      spared: preview.spared,
      disk_scan: {
        dirs: scan.dirCount,
        files: scan.fileCount,
        errors: scan.errors,
      },
    };
  }

  const lockPath = lockPathFor(storage);
  let lock;
  try {
    lock = await acquireLock(lockPath, {
      timeoutMs: opts.lockTimeoutMs,
      retryMs: opts.lockRetryMs,
    });
  } catch (err) {
    return { ok: false, error: `lock: ${err && err.message ? err.message : String(err)}` };
  }

  try {
    const projection = await loadProjection(storage);
    const plan = computePruneCandidates(projection, {
      diskCsids: scan.csids,
      olderThanMs: opts.olderThanMs,
      now: opts.now,
    });

    const pruned = [];
    const failed = [];
    for (const c of plan.candidates) {
      const event = newEvent({
        op: 'session_prune',
        stable_id: c.stable_id,
        payload: {
          reason: typeof opts.reason === 'string' && opts.reason.length > 0
            ? opts.reason
            : 'ghost: no prompt, no fingerprint, no transcript on disk',
          claude_session_ids: c.claude_session_ids,
          created_at: c.created_at,
          age_hours: c.age_hours,
        },
      });
      try {
        // SSoT first, exactly as tryUpdateProjection does — durability of the
        // tombstone must not depend on the projection write succeeding.
        await appendEvent(event, storage);
      } catch (err) {
        failed.push({ stable_id: c.stable_id, error: err && err.message ? err.message : String(err) });
        continue;
      }
      applyEvent(projection, event);
      pruned.push({ ...c, event_id: event.event_id });
    }

    if (pruned.length > 0) {
      // Single save for the whole batch — we already hold the lock.
      await saveProjection(projection, { ...storage, withLock: false });
    }

    return {
      ok: failed.length === 0,
      dryRun: false,
      pruned,
      failed,
      scanned: plan.scanned,
      spared: plan.spared,
      disk_scan: { dirs: scan.dirCount, files: scan.fileCount, errors: scan.errors },
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    lock.release();
  }
}

