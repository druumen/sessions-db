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
 * Validate and clean one alias value — the single rule both the write path
 * and `cli/alias.mjs --dry-run` answer to.
 *
 * Extracted because the dry run had been reimplementing half of it: it
 * sanitised (so the preview showed the right bytes) but did not re-check the
 * result, so an alias that is nothing but escape sequences previewed as
 * `{"alias":""}` — an event the real write refuses outright. A dry run that
 * describes a write that cannot happen is worse than no dry run, and the only
 * durable fix is for there to be one rule rather than two that agree today.
 *
 * Sanitising before the length check is deliberate: the cap has to apply to
 * what is actually stored, and an all-escape value has to fail with a reason
 * rather than be written as an empty name.
 *
 * Errors are worded as user-facing sentences with no caller prefix, so
 * `setAlias` can prefix them for the library surface while the CLI prints
 * them as-is.
 *
 * @param {unknown} alias
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function normalizeAliasValue(alias: unknown): {
    ok: true;
    value: string;
} | {
    ok: false;
    error: string;
};
/**
 * Canonical payload for an alias write. Shared with `cli/alias.mjs --dry-run`
 * so the preview and the write cannot diverge.
 *
 * The `alias_set` shape (`{ alias }`), not `{ channel, value, source }` —
 * see `setAlias` for why the legacy op is still the one being written. The
 * channel, the `human` source and the display precedence are all derived
 * from the op by `nameChangeFromEvent`, so nothing is lost by not spelling
 * them out.
 *
 * @param {string|null} value already sanitised by the caller
 */
export function aliasSetPayload(value: string | null): {
    alias: string;
};
/**
 * Set or clear a name on any channel.
 *
 * The general form behind `setAlias`, and the write path a consumer needs in
 * order to push back a name it observed itself — cockpit reads Claude Code's
 * `custom-title` off disk on every render, and until something writes it, the
 * database never learns the one name a human actually typed.
 *
 * `channel` and `source` are open strings: this function validates that they
 * are well-formed (length + identifier charset), never that they are already
 * known. Refusing an unknown channel here would defeat the point of an open
 * set — a new namer is supposed to be a non-event.
 *
 * `value: null` (or `clear: true`) records a deliberate clear. It is a
 * history entry, not a deletion: "somebody removed this name" is itself
 * information, and a delete would make it indistinguishable from
 * "never named".
 *
 * @param {{
 *   stableId: string,
 *   channel: string,
 *   value?: string|null,
 *   clear?: boolean,
 *   source?: string,
 *   observedFrom?: string,
 *   observedAt?: string,
 *   rootPath?: string,
 *   root?: string,
 *   paths?: object,
 * }} opts
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export function setName(opts: {
    stableId: string;
    channel: string;
    value?: string | null;
    clear?: boolean;
    source?: string;
    observedFrom?: string;
    observedAt?: string;
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
