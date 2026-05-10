/**
 * Initialize sessions-db storage at the given root.
 *
 * @param {{
 *   rootPath: string,
 *   paths?: { eventsJsonl?: string, projectionJson?: string, lockFile?: string },
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   created?: { dir: boolean, eventsJsonl: boolean, projectionJson: boolean },
 *   paths?: { eventsJsonl: string, projectionJson: string },
 *   error?: string,
 * }>}
 */
export function initProjection(opts: {
    rootPath: string;
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
    error?: string;
}>;
