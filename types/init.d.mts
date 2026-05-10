/**
 * Initialize sessions-db storage at the given root.
 *
 * Resolution semantics (Day 4):
 *
 *   - `opts.paths` (legacy form) — fully-formed override: each `eventsJsonl`
 *     / `projectionJson` is anchored on `opts.rootPath` (or treated as
 *     absolute if it starts with `/`). Backward-compatible with Day 3
 *     callers that passed `paths: { eventsJsonl: 'custom/events.jsonl', ... }`.
 *
 *   - `opts.rootPath` (Day 4 form, no `opts.paths`) — `rootPath` IS the
 *     storage directory; files live directly under it as
 *     `<rootPath>/sessions-db-events.jsonl` and `<rootPath>/sessions-db.json`.
 *     This is what cockpit's Setup Wizard passes (typically resolved to
 *     `<workspace>/.dru-code/`).
 *
 *   - No opts (default) — delegates to `resolveStoragePaths()` which runs
 *     the env > existing-storage > cwd/.dru-code chain. Useful for ad-hoc
 *     "init wherever the resolver thinks it should go" scripts.
 *
 * @param {{
 *   rootPath?: string,
 *   paths?: { eventsJsonl?: string, projectionJson?: string, lockFile?: string },
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   created?: { dir: boolean, eventsJsonl: boolean, projectionJson: boolean },
 *   paths?: { eventsJsonl: string, projectionJson: string },
 *   source?: string,
 *   error?: string,
 * }>}
 */
export function initProjection(opts?: {
    rootPath?: string;
    paths?: {
        eventsJsonl?: string;
        projectionJson?: string;
        lockFile?: string;
    };
}): Promise<{
    ok: boolean;
    created?: {
        dir: boolean;
        eventsJsonl: boolean;
        projectionJson: boolean;
    };
    paths?: {
        eventsJsonl: string;
        projectionJson: string;
    };
    source?: string;
    error?: string;
}>;
