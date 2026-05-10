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
export function setAlias(opts: {
    stableId: string;
    alias?: string;
    clear?: boolean;
    rootPath?: string;
    root?: string;
    paths?: object;
}): Promise<{
    ok: boolean;
    event_id?: string;
    error?: string;
}>;
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
export function linkTask(opts: {
    stableId: string;
    tasks?: string[];
    projects?: string[];
    rootPath?: string;
    root?: string;
    paths?: object;
}): Promise<{
    ok: boolean;
    event_id?: string;
    error?: string;
}>;
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
export function unlinkTask(opts: {
    stableId: string;
    tasks?: string[];
    projects?: string[];
    rootPath?: string;
    root?: string;
    paths?: object;
}): Promise<{
    ok: boolean;
    event_id?: string;
    error?: string;
}>;
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
export function setParent(opts: {
    childId: string;
    parentId?: string;
    clear?: boolean;
    rootPath?: string;
    root?: string;
    paths?: object;
}): Promise<{
    ok: boolean;
    event_id?: string;
    error?: string;
}>;
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
export function closeSession(opts: {
    stableId: string;
    outcome: string;
    reason?: string;
    rootPath?: string;
    root?: string;
    paths?: object;
}): Promise<{
    ok: boolean;
    event_id?: string;
    error?: string;
}>;
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
export function runSweep(opts?: {
    rootPath?: string;
    root?: string;
    paths?: object;
    idleThresholdDays?: number;
    archiveThresholdDays?: number;
    dryRun?: boolean;
    now?: number;
}): Promise<{
    ok: true;
    dryRun: true;
    transitions: Array<object>;
} | {
    ok: boolean;
    applied: Array<object>;
    failed: Array<object>;
    summary: object;
}>;
