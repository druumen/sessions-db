/**
 * Read a single JSON object from stdin within `timeoutMs`. Returns null on
 * timeout, empty stdin, or invalid JSON. Never throws.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object|null>}
 */
export function readStdinJson({ timeoutMs }?: {
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * Decide whether a hook is allowed to record events for `cwd`.
 *
 * Two acceptance fast-paths, either of which is sufficient:
 *
 *   1. **Druumen Workspace sentinel** — a `CLAUDE.md` at `cwd` or any
 *      ancestor whose body contains the literal string "Druumen Workspace".
 *      Original 0.1.x gate; how the Druumen monorepo opts in.
 *
 *   2. **Pre-initialized sessions-db storage** — `.dru-code/sessions-db.json`
 *      or `tickets/_logs/sessions-db.json` already exists at `cwd` or any
 *      ancestor. The cockpit Setup Wizard creates this file when the user
 *      explicitly enables sessions tracking for a workspace; an external
 *      project that has never opted in will not have either marker.
 *
 * Either marker is treated as user consent for this workspace. The walk is
 * bounded to 12 ancestors so a runaway loop (e.g. weird FS mount) cannot
 * stall us; the loop terminates early as soon as ANY marker is found at the
 * current level.
 *
 * The function name is kept (`isDruumenWorkspace`) for git history clarity
 * even though the semantic has broadened to "authorized workspace".
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function isDruumenWorkspace(cwd: string): boolean;
/**
 * WHICH workspace `cwd` belongs to — the same ascent `isDruumenWorkspace`
 * does, returning the directory instead of a boolean.
 *
 * Split out rather than duplicated: a caller standing in
 * `<workspace>/products/web` needs the workspace itself (to anchor storage and
 * a gate on it), and re-implementing the walk is how the two answers drift.
 * `isDruumenWorkspace` is now this function plus a null check, so there is
 * exactly one ascent in the package.
 *
 * @param {string} cwd
 * @returns {string|null} the workspace root, or null when `cwd` is not inside one
 */
export function druumenWorkspaceRoot(cwd: string): string | null;
/**
 * Does `dir` ITSELF already hold an initialized sessions-db (either storage
 * convention: cockpit-marketplace `.dru-code/` or druumen-monorepo
 * `tickets/_logs/`)? No ancestor walk — the question is specifically "is this
 * directory a storage root", not "is it inside a tracked workspace".
 *
 * Two callers, both of which need the narrow question:
 *   - `isDruumenWorkspace` walks ancestors itself and asks per level.
 *   - the `UserPromptSubmit` hook asks it about a cwd it is considering
 *     anchoring storage on when the git probe could not give it a worktree
 *     root. Anchoring on a directory that is NOT already a storage root would
 *     CREATE a second database inside the user's repo (observed: a
 *     `packages/deep/app/tickets/_logs/` appearing in `git status`), so "we
 *     already write here" is exactly the fact that has to be true.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function hasInitializedStorage(dir: string): boolean;
/**
 * Resolve which storage location a hook should write into.
 *
 * Three-tier strategy so cockpit-marketplace users (who have a `.dru-code/`
 * storage dir) and druumen-monorepo users (who have a `tickets/_logs/`
 * storage dir) BOTH have their hooks write into the exact location their
 * reader is watching:
 *
 *   (a) `DRUUMEN_SESSIONS_DB_ROOT` env var overrides everything. Cockpit's
 *       Setup Wizard writes this into the hook command line so the hook knows
 *       the precise storage dir the user opted into via Enable. Forwarded as
 *       `{ rootPath }` — storage treats it as the bare storage dir (no
 *       `tickets/_logs/` prefix added).
 *
 *   (b) Auto-detect `<workspaceRoot>/.dru-code/sessions-db.json`. If the user
 *       (or wizard) opted in via the new-convention layout we honor it
 *       without polluting their repo with a `tickets/_logs/` subdir.
 *
 *   (c) Fall back to the historic `{ root: workspaceRoot }` form which writes
 *       under `<workspaceRoot>/tickets/_logs/`.
 *
 * NEVER falls back to `process.cwd()` — the caller passes the workspace root
 * it committed to from the hook payload, which is the whole point.
 *
 * @param {{ workspaceRoot: string }} args
 * @returns {{ rootPath: string } | { root: string }}
 */
export function resolveStorageTarget({ workspaceRoot }: {
    workspaceRoot: string;
}): {
    rootPath: string;
} | {
    root: string;
};
/**
 * @param {unknown} v
 * @returns {string|null} `v` when it is a non-empty string, else null
 */
export function pickString(v: unknown): string | null;
/**
 * Cheap UUID-shape validator. We don't want to lock ourselves to v4-only or
 * v7-only since Claude Code's session_id format may evolve, but we DO want to
 * reject obvious junk (empty / control chars / whitespace) that would corrupt
 * the events.jsonl line.
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function looksLikeUuid(s: unknown): boolean;
/**
 * Privacy opt-out predicate for `DRUUMEN_SESSIONS_DB_STORE_PREVIEW`.
 *
 * Returns true ONLY for the literal opt-out values `'0'` and `'false'`
 * (case-insensitive, after trim). Everything else — unset, empty string,
 * `'1'`, `'true'`, `'yes'`, garbage — keeps the default-on behavior.
 *
 * Why this asymmetric shape? The default is preview-stored (backward compat
 * with 0.1.0-dev) and we want a typo in the env var to fail SAFE: an operator
 * who intends to opt out but mistypes (e.g. sets `=False` and trusts
 * case-insensitivity) gets opt-out, but a typo like `=fals` or `=disabled`
 * keeps the default. Treating only the two canonical strings as off-signals
 * makes the gate predictable; cockpit's Setup Wizard always writes one of the
 * two canonical values when the user unticks the box.
 *
 * @param {unknown} envValue
 * @returns {boolean}
 */
export function isPreviewDisabled(envValue: unknown): boolean;
