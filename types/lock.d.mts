/**
 * Acquire an exclusive lock on `lockPath`.
 *
 * @param {string} lockPath - Absolute path to the lock file. Parent dir must
 *   exist; we do not mkdir-p (callers control layout).
 * @param {{ timeoutMs?: number, retryMs?: number }} [opts]
 * @returns {Promise<{ release: () => void }>} - Resolves with a release
 *   handle. `release()` is idempotent: calling it twice is a no-op.
 *
 * Throws on timeout: `Error("acquireLock: timeout after <ms>ms (path=...)").`
 * Re-throws unexpected fs errors verbatim (anything other than EEXIST).
 */
export function acquireLock(lockPath: string, opts?: {
    timeoutMs?: number;
    retryMs?: number;
}): Promise<{
    release: () => void;
}>;
