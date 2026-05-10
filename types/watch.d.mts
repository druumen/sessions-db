/**
 * Watch the projection file at `rootPath` and invoke `listener` on change.
 *
 * Path resolution (Day 4 — symmetric with storage.mjs):
 *
 *   - If `opts.paths.projectionJson` is provided, that's the file watched
 *     (anchored on `rootPath` if relative). Backward-compat with Day 1-3.
 *
 *   - Otherwise `rootPath` is treated as a Day 4 storage root and we
 *     delegate to `resolveStoragePaths({ rootPath })` so the canonical
 *     filename + cross-platform path normalization apply uniformly.
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
