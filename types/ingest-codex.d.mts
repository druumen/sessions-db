/**
 * Is `child` the same path as `parent` or inside it?
 *
 * String prefix with an explicit separator, not `startsWith(parent)`:
 * `/a/workspace-old` starts with `/a/workspace` and is a DIFFERENT directory.
 */
export function isInside(parent: any, child: any): any;
/**
 * @param {{workspaceRoot: string, storage?: object, dryRun?: boolean,
 *   limit?: number, codexRoot?: string, now?: string}} opts
 * @returns {Promise<{ok: boolean, dryRun: boolean, scanned: number,
 *   unparseable: number, skippedNotWorkspace: number, skippedOtherWorkspace: number,
 *   alreadyKnown: number, ingested: number,
 *   sessions: Array<{codex_session_id: string, stable_id: string, cwd: string,
 *     started_at: string|null, last_activity_at: string|null,
 *     originator: string|null, first_prompt_preview: string|null}>}>}
 */
export function runIngestCodex(opts?: {
    workspaceRoot: string;
    storage?: object;
    dryRun?: boolean;
    limit?: number;
    codexRoot?: string;
    now?: string;
}): Promise<{
    ok: boolean;
    dryRun: boolean;
    scanned: number;
    unparseable: number;
    skippedNotWorkspace: number;
    skippedOtherWorkspace: number;
    alreadyKnown: number;
    ingested: number;
    sessions: Array<{
        codex_session_id: string;
        stable_id: string;
        cwd: string;
        started_at: string | null;
        last_activity_at: string | null;
        originator: string | null;
        first_prompt_preview: string | null;
    }>;
}>;
