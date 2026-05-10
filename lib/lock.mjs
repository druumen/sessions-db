/**
 * File-based exclusive lock helper for sessions-db projection writes.
 *
 * Uses POSIX `O_CREAT | O_EXCL` semantics via `fs.openSync(path, 'wx')`:
 * - Atomic create-or-fail across processes on a single filesystem
 * - On EEXIST we retry until either the lock is released by the holder or
 *   the timeout window elapses
 *
 * The lock file content is `<pid>\t<iso-ts>\n` (one line). Future phases will
 * use the embedded PID for stale-lock detection (kill -0 PID); this phase
 * intentionally does not implement stale recovery — Phase 1 ticket §"Stale
 * lock detection (PID-based)" is explicitly out of scope.
 *
 * Zero new npm deps: only `node:fs`, `node:timers/promises`.
 */

import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 50;

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
export async function acquireLock(lockPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let fd;
    try {
      // 'wx' === O_WRONLY | O_CREAT | O_EXCL — atomic create-or-fail.
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        if (Date.now() >= deadline) {
          throw new Error(
            `acquireLock: timeout after ${timeoutMs}ms (path=${lockPath})`,
          );
        }
        await sleep(retryMs);
        continue;
      }
      throw err;
    }

    // Stamp PID + iso ts so future stale-lock detection has the metadata
    // it needs. Failure to write metadata still gives us the lock — release
    // proceeds normally.
    try {
      const stamp = `${process.pid}\t${new Date().toISOString()}\n`;
      writeSync(fd, stamp);
    } catch {
      // Non-fatal: keep the lock, swallow metadata write error.
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        // fd may already be closed in edge cases — ignore.
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // lock may already be gone — ignore.
      }
    };

    return { release };
  }
}
