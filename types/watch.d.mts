/**
 * Watch the projection file at `rootPath` and invoke `listener` on change.
 *
 * @param {string} rootPath
 * @param {(event: { type: 'change' | 'rename' | 'poll', path: string }) => void} listener
 * @param {{
 *   paths?: { projectionJson?: string },
 *   pollIntervalMs?: number,
 *   debounceMs?: number,
 * }} [opts]
 * @returns {{ dispose: () => void }}
 */
export function watchProjection(rootPath: string, listener: (event: {
    type: "change" | "rename" | "poll";
    path: string;
}) => void, opts?: {
    paths?: {
        projectionJson?: string;
    };
    pollIntervalMs?: number;
    debounceMs?: number;
}): {
    dispose: () => void;
};
