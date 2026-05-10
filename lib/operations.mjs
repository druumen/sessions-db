/**
 * Library-API operations for sessions-db.
 *
 * These wrap the storage primitives (`tryUpdateProjection` + `loadProjection`)
 * with input validation, business invariants, and a uniform `{ ok, event_id?,
 * error? }` result shape so callers (the CLI handlers AND library consumers
 * such as cockpit) do not have to re-implement the same checks.
 *
 * Three contracts every operation here MUST honor:
 *
 *   1. **Validate before write.** Each operation rejects invalid input and
 *      missing target sessions BEFORE appending to events.jsonl. We do not
 *      want the SSoT to grow `alias_set` events for non-existent sessions.
 *
 *   2. **Result shape.** Success → `{ ok: true, event_id: '<evt_...>' }`.
 *      Failure → `{ ok: false, error: '<message>' }`. Operations DO NOT
 *      throw for business-class failures (lock timeout, not-found, cycle).
 *      System-class failures (disk full, permission denied) are caught by
 *      `tryUpdateProjection` and returned as `{ ok: false }` too — operations
 *      preserve that shape rather than re-raising.
 *
 *   3. **Lock-safe.** Every operation that mutates the projection routes
 *      through `tryUpdateProjection`, which holds the projection lock across
 *      the load → apply → save cycle. Operations never themselves perform
 *      raw `appendEvent` / `saveProjection` outside that primitive.
 *
 * Adding a new operation: write a thin function that builds the canonical
 * event payload, calls `tryUpdateProjection`, and returns `commitResult()`.
 * Resist the urge to extend signatures with `--dry-run` or `--json` —
 * those are CLI-display concerns; the library returns structured results
 * and lets the caller render them.
 */

import { computeSweepTransitions } from './sweep.mjs';
import {
  loadProjection,
  newEvent,
  tryUpdateProjection,
} from './storage.mjs';

const VALID_OUTCOMES = new Set([
  'open',
  'done',
  'blocked',
  'abandoned',
  'merged',
  'superseded',
]);

const MAX_PARENT_CHAIN_DEPTH = 50;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `{ rootPath, root, paths }` opts into a single object suitable
 * for storage primitives. All fields are optional; when omitted we let
 * storage fall back to its full Day 4 resolution chain (env → ascend →
 * cwd/.dru-code).
 *
 * Storage's `resolvePaths` honors all three shapes (`paths` > `rootPath`
 * > `root` > default), so we just pass them through. Callers picking
 * `rootPath` (Day 4 form) get the canonical-filename layout; callers on
 * the legacy `root` form keep the `tickets/_logs/` anchored layout.
 */
function storageOpts({ rootPath, root, paths } = {}) {
  const out = {};
  if (rootPath !== undefined) out.rootPath = rootPath;
  if (root !== undefined) out.root = root;
  if (paths !== undefined) out.paths = paths;
  return out;
}

/**
 * Verify a stable_id exists in the projection. Returns the matched session
 * record on success or `{ ok: false, error }` on miss. Library consumers
 * differentiate the miss via the `error` string; CLI wraps it in stderr +
 * exit 1.
 */
async function ensureSessionExists(stableId, opts) {
  const projection = await loadProjection(storageOpts(opts));
  const session = projection.sessions && projection.sessions[stableId];
  if (!session) {
    return { ok: false, error: `stable_id not found: ${stableId}`, projection: null };
  }
  return { ok: true, projection, session };
}

/**
 * Build event + commit through tryUpdateProjection. Returns the canonical
 * library-API result shape.
 */
async function commitOp({ op, stableId, payload, opts }) {
  const event = newEvent({ op, stable_id: stableId, payload });
  const result = await tryUpdateProjection(event, storageOpts(opts));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, event_id: event.event_id };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Set or clear the human-readable alias on a session.
 *
 * Either `alias` (non-empty string) or `clear: true` must be provided —
 * mutually exclusive. Validation matches the CLI's argparse behavior so the
 * library consumer surface is symmetric with the CLI surface.
 *
 * @param {{
 *   stableId: string,
 *   alias?: string,
 *   clear?: boolean,
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 * }} opts
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export async function setAlias(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'setAlias: opts required' };
  }
  const { stableId, alias, clear } = opts;
  if (typeof stableId !== 'string' || stableId.length === 0) {
    return { ok: false, error: 'setAlias: stableId required' };
  }
  const wantsClear = clear === true;
  const hasAlias = alias !== undefined && alias !== null;
  if (wantsClear && hasAlias) {
    return { ok: false, error: 'setAlias: alias and clear are mutually exclusive' };
  }
  if (!wantsClear && !hasAlias) {
    return { ok: false, error: 'setAlias: provide alias or clear=true' };
  }
  if (hasAlias && (typeof alias !== 'string' || alias.length === 0)) {
    return { ok: false, error: 'setAlias: alias must be a non-empty string' };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = wantsClear ? { alias: null } : { alias };
  return commitOp({ op: 'alias_set', stableId, payload, opts });
}

/**
 * Link a session to one or more tasks / projects (additive, idempotent).
 *
 * At least one of `tasks` / `projects` must be a non-empty array. The
 * reducer already de-dupes against existing entries so re-running with the
 * same payload is a no-op on projection state (but still writes an audit
 * event).
 *
 * @param {{
 *   stableId: string,
 *   tasks?: string[],
 *   projects?: string[],
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 * }} opts
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export async function linkTask(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'linkTask: opts required' };
  }
  const { stableId } = opts;
  if (typeof stableId !== 'string' || stableId.length === 0) {
    return { ok: false, error: 'linkTask: stableId required' };
  }
  const tasks = normalizeIdList(opts.tasks);
  const projects = normalizeIdList(opts.projects);
  if (tasks.length === 0 && projects.length === 0) {
    return { ok: false, error: 'linkTask: provide at least one task or project' };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = {};
  if (tasks.length > 0) payload.tasks = tasks;
  if (projects.length > 0) payload.projects = projects;
  return commitOp({ op: 'session_link', stableId, payload, opts });
}

/**
 * Unlink one or more tasks / projects from a session (set-based filter,
 * idempotent). Removing an id that isn't present is a no-op on projection
 * state but still produces an audit event — operator intent is recorded
 * regardless of resulting state change.
 *
 * @param {{
 *   stableId: string,
 *   tasks?: string[],
 *   projects?: string[],
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 * }} opts
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export async function unlinkTask(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'unlinkTask: opts required' };
  }
  const { stableId } = opts;
  if (typeof stableId !== 'string' || stableId.length === 0) {
    return { ok: false, error: 'unlinkTask: stableId required' };
  }
  const tasks = normalizeIdList(opts.tasks);
  const projects = normalizeIdList(opts.projects);
  if (tasks.length === 0 && projects.length === 0) {
    return { ok: false, error: 'unlinkTask: provide at least one task or project' };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = {};
  if (tasks.length > 0) payload.tasks = tasks;
  if (projects.length > 0) payload.projects = projects;
  return commitOp({ op: 'session_unlink', stableId, payload, opts });
}

/**
 * Set or clear the hub-spoke parent relationship for a session.
 *
 * Either `parentId` (non-empty string, distinct from `childId`) or `clear:
 * true` must be provided. When setting a parent we:
 *   - reject self-cycle (parentId === childId, exit-1 in CLI)
 *   - verify parent exists
 *   - walk parent's ancestor chain up to MAX_PARENT_CHAIN_DEPTH and reject
 *     if `childId` appears anywhere — that would close a cycle of length
 *     ≥ 2 (e.g. existing A→B + proposed `setParent({childId: B, parentId: A})`
 *     would form A→B→A).
 *
 * The MAX_PARENT_CHAIN_DEPTH bound is a defense against a stale projection
 * cycle (rare; would require an earlier guard bypass). 50 is generous —
 * real hub-spoke chains are 1-3 hops.
 *
 * @param {{
 *   childId: string,
 *   parentId?: string,
 *   clear?: boolean,
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 * }} opts
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export async function setParent(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'setParent: opts required' };
  }
  const { childId, parentId, clear } = opts;
  if (typeof childId !== 'string' || childId.length === 0) {
    return { ok: false, error: 'setParent: childId required' };
  }
  const wantsClear = clear === true;
  const hasParent = parentId !== undefined && parentId !== null;
  if (wantsClear && hasParent) {
    return { ok: false, error: 'setParent: parentId and clear are mutually exclusive' };
  }
  if (!wantsClear && !hasParent) {
    return { ok: false, error: 'setParent: provide parentId or clear=true' };
  }
  if (hasParent && (typeof parentId !== 'string' || parentId.length === 0)) {
    return { ok: false, error: 'setParent: parentId must be a non-empty string' };
  }
  if (hasParent && parentId === childId) {
    return {
      ok: false,
      error: 'setParent: parent and child cannot be the same stable_id',
    };
  }

  // Verify child exists. Cycle detection must use the same projection load
  // so the walk reflects what storage will see when the event commits.
  const childCheck = await ensureSessionExists(childId, opts);
  if (!childCheck.ok) return { ok: false, error: childCheck.error };

  if (hasParent) {
    const projection = childCheck.projection;
    const parentSession = projection.sessions && projection.sessions[parentId];
    if (!parentSession) {
      return { ok: false, error: `stable_id not found: ${parentId}` };
    }

    // Multi-hop cycle detection — walk parent's ancestor chain via
    // parent_session_id pointers; refuse if we encounter `childId` along
    // the way. The 1-cycle (parentId === childId) was already rejected.
    let cursor = parentId;
    for (let depth = 0; depth < MAX_PARENT_CHAIN_DEPTH && cursor; depth++) {
      if (cursor === childId) {
        return {
          ok: false,
          error:
            `setParent: would create a cycle: proposed parent ${parentId} ` +
            `reaches child ${childId} after ${depth} hop(s)`,
        };
      }
      const ancestor = projection.sessions && projection.sessions[cursor];
      cursor = ancestor && ancestor.parent_session_id
        ? ancestor.parent_session_id
        : null;
    }
  }

  const payload = wantsClear
    ? { parent_session_id: null }
    : { parent_session_id: parentId };
  return commitOp({ op: 'parent_set', stableId: childId, payload, opts });
}

/**
 * Close (or reopen) a session with a terminal outcome.
 *
 * Outcome enum is enforced (matches projection schema): open | done |
 * blocked | abandoned | merged | superseded. `open` is allowed — operators
 * may reopen a previously-closed session by passing `outcome: 'open'`; the
 * reducer's closed_at always tracks the latest close event so the reopen is
 * visible in the audit trail.
 *
 * @param {{
 *   stableId: string,
 *   outcome: string,
 *   reason?: string,
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 * }} opts
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export async function closeSession(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'closeSession: opts required' };
  }
  const { stableId, outcome, reason } = opts;
  if (typeof stableId !== 'string' || stableId.length === 0) {
    return { ok: false, error: 'closeSession: stableId required' };
  }
  if (typeof outcome !== 'string' || outcome.length === 0) {
    return { ok: false, error: 'closeSession: outcome required' };
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    return {
      ok: false,
      error:
        `closeSession: outcome must be one of: ` +
        `${[...VALID_OUTCOMES].join(', ')}`,
    };
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return { ok: false, error: 'closeSession: reason must be a string' };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };

  const payload = { outcome };
  if (reason !== undefined) payload.closed_reason = reason;
  return commitOp({ op: 'close', stableId, payload, opts });
}

/**
 * Compute and (optionally) apply activity_state transitions across all
 * sessions in the projection.
 *
 * Returns:
 *   - dryRun: true → `{ ok: true, dryRun: true, transitions }` with the
 *     planned transitions list (no events written).
 *   - dryRun: false → `{ ok: boolean, applied, failed, summary }` after
 *     attempting each transition through `tryUpdateProjection`. `ok` is
 *     true when zero failures.
 *
 * Lock model: each transition acquires the projection lock independently
 * via `tryUpdateProjection`. For typical sweep volumes (single digits per
 * run) this is fine; if the workspace grows huge a future `--batch` mode
 * can fold all transitions into a single under-lock pass.
 *
 * @param {{
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 *   idleThresholdDays?: number,
 *   archiveThresholdDays?: number,
 *   dryRun?: boolean,
 *   now?: number,
 * }} [opts]
 * @returns {Promise<
 *   | { ok: true, dryRun: true, transitions: Array<object> }
 *   | { ok: boolean, applied: Array<object>, failed: Array<object>, summary: object }
 * >}
 */
export async function runSweep(opts = {}) {
  const idleThresholdDays = opts.idleThresholdDays;
  const archiveThresholdDays = opts.archiveThresholdDays;

  if (idleThresholdDays !== undefined
      && (!Number.isFinite(idleThresholdDays) || idleThresholdDays <= 0)) {
    return {
      ok: false,
      error: `runSweep: idleThresholdDays must be a positive number (got: ${idleThresholdDays})`,
    };
  }
  if (archiveThresholdDays !== undefined
      && (!Number.isFinite(archiveThresholdDays) || archiveThresholdDays <= 0)) {
    return {
      ok: false,
      error: `runSweep: archiveThresholdDays must be a positive number (got: ${archiveThresholdDays})`,
    };
  }
  if (idleThresholdDays !== undefined
      && archiveThresholdDays !== undefined
      && archiveThresholdDays < idleThresholdDays) {
    return {
      ok: false,
      error:
        `runSweep: archiveThresholdDays (${archiveThresholdDays}) must be >= ` +
        `idleThresholdDays (${idleThresholdDays})`,
    };
  }

  const projection = await loadProjection(storageOpts(opts));
  const transitions = computeSweepTransitions(projection, {
    idleThresholdDays,
    archiveThresholdDays,
    now: opts.now,
  });

  if (opts.dryRun === true) {
    return { ok: true, dryRun: true, transitions };
  }

  const applied = [];
  const failed = [];
  for (const t of transitions) {
    const event = newEvent({
      op: 'sweep',
      stable_id: t.stable_id,
      payload: {
        activity_state: t.to_state,
        effective_last_progress: t.effective_last_progress,
      },
    });
    const result = await tryUpdateProjection(event, storageOpts(opts));
    if (result.ok) {
      applied.push({ ...t, event_id: event.event_id });
    } else {
      failed.push({ ...t, error: result.error });
    }
  }

  const toIdle = applied.filter((a) => a.to_state === 'idle').length;
  const toArchived = applied.filter((a) => a.to_state === 'archived').length;
  return {
    ok: failed.length === 0,
    applied,
    failed,
    summary: {
      total: transitions.length,
      applied: applied.length,
      failed: failed.length,
      to_idle: toIdle,
      to_archived: toArchived,
    },
  };
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

/**
 * Coerce an id-list input into a deduped array of non-empty strings.
 * Accepts undefined / null / single-string / array. Used by linkTask /
 * unlinkTask so a caller passing `'foo'` instead of `['foo']` still works.
 */
function normalizeIdList(input) {
  if (input === undefined || input === null) return [];
  const arr = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string' || v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
