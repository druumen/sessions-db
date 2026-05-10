/**
 * Resolve storage paths from caller opts + env + autodiscover.
 *
 * @param {{ rootPath?: string, cwd?: string }} [opts]
 * @returns {{
 *   root: string,
 *   eventsJsonl: string,
 *   projectionJson: string,
 *   lockFile: string,
 *   source: 'arg' | 'env' | 'tickets-logs' | 'dru-code' | 'default',
 * }}
 */
export function resolveStoragePaths(opts?: {
    rootPath?: string;
    cwd?: string;
}): {
    root: string;
    eventsJsonl: string;
    projectionJson: string;
    lockFile: string;
    source: "arg" | "env" | "tickets-logs" | "dru-code" | "default";
};
/**
 * Helper for callers that already have a fully-resolved root and want to
 * compute file paths (tests, custom integrations). Public so consumers can
 * mirror the layout invariant without importing internal helpers.
 *
 * @param {string} root absolute or relative; resolved against cwd if relative
 * @returns {{ root: string, eventsJsonl: string, projectionJson: string, lockFile: string }}
 */
export function pathsFromRoot(root: string): {
    root: string;
    eventsJsonl: string;
    projectionJson: string;
    lockFile: string;
};
/**
 * Hard cap on cwd-ascend depth. Twelve levels is generous — a typical
 * worktree depth is 1-3, monorepos may go to 5-6. Pinning at 12 means the
 * worst-case stat budget is 24 (two candidate paths × 12 levels) before
 * we fall through to the default. Set deliberately conservative so the
 * resolver never accidentally walks to `/` on a slow networked mount.
 */
export const MAX_ASCEND_DEPTH: 12;
/**
 * The three on-disk filenames (relative to whichever root the resolver
 * picks). Frozen so callers can't accidentally mutate. Exported for tests
 * + the rare library consumer that wants to know the canonical names.
 */
export const STORAGE_FILENAMES: Readonly<{
    eventsJsonl: "sessions-db-events.jsonl";
    projectionJson: "sessions-db.json";
    lockFile: "sessions-db.json.lock";
}>;
