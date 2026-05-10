/**
 * Projection-file watcher for sessions-db.
 *
 * `watchProjection(rootPath, listener)` invokes `listener` whenever the
 * projection cache (`tickets/_logs/sessions-db.json` by default) changes.
 * Returns a Disposable (`{ dispose }`) so callers can unsubscribe — used
 * by cockpit to feed the live UI without re-polling the on-disk JSON.
 *
 * Two redundant signals are wired up:
 *
 *   1. **fs.watch** — the OS-level inotify / FSEvents subscription. Fast
 *      (sub-100ms latency on typical hardware) but unreliable under some
 *      conditions:
 *        - editors that "atomic save" (write to tmp + rename) deliver a
 *          `rename` event but the watcher dies on the inode swap on Linux
 *        - networked filesystems may drop events
 *        - macOS FSEvents coalesces aggressively under load
 *
 *   2. **1s polling fallback** — `setInterval` reads `mtimeMs` and fires
 *      the listener if it changed since the last poll. Bounded latency
 *      regardless of watcher health. Cheap (a single stat per second).
 *
 * Both paths funnel through a single **80ms debounce** window so a flurry
 * of events (sweep applying multiple transitions, or fs.watch + poll both
 * detecting the same write) collapses into one listener call. The window
 * is internal — callers do not need to debounce themselves.
 *
 * Why 80ms? Long enough to coalesce a write-then-rename (atomic save) and
 * a fs.watch+poll race (typically < 50ms apart), short enough that the UI
 * still feels live. Tunable via `opts.debounceMs` for tests.
 *
 * Listener contract:
 *   - Called as `listener({ type, path })` where `type` is one of
 *     `'change' | 'rename' | 'poll'` (whichever signal fired) and `path`
 *     is the absolute path to projection.json.
 *   - Synchronous; if your handler is async, swallow promise rejections
 *     yourself — the watcher does NOT await.
 *   - Errors thrown by the listener are caught and silently ignored so a
 *     buggy consumer doesn't crash the watcher loop.
 */

import { existsSync, statSync, watch } from 'node:fs';

import { PATHS } from './storage.mjs';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 80;

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
export function watchProjection(rootPath, listener, opts = {}) {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new TypeError('watchProjection: rootPath required');
  }
  if (typeof listener !== 'function') {
    throw new TypeError('watchProjection: listener function required');
  }

  const projectionRel = (opts.paths && opts.paths.projectionJson)
    ?? PATHS.projectionJson;
  const projectionPath = projectionRel.startsWith('/')
    ? projectionRel
    : `${rootPath}/${projectionRel}`;

  const pollIntervalMs = typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0
    ? opts.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const debounceMs = typeof opts.debounceMs === 'number' && opts.debounceMs >= 0
    ? opts.debounceMs
    : DEFAULT_DEBOUNCE_MS;

  // Debounce coalesces multiple events within `debounceMs` into one listener
  // call. We capture the LAST fired event's `type` so the consumer sees the
  // most recent signal source ("rename" wins over earlier "change" within the
  // same window — useful for atomic-save detection).
  let pendingTimer = null;
  let pendingType = null;
  const fireSoon = (type) => {
    pendingType = type;
    if (pendingTimer !== null) return;
    pendingTimer = setTimeout(() => {
      const t = pendingType;
      pendingTimer = null;
      pendingType = null;
      try {
        listener({ type: t, path: projectionPath });
      } catch {
        // Swallow listener errors — a buggy consumer must not kill the
        // watcher. If they need observability, they should add their own
        // try/catch.
      }
    }, debounceMs);
  };

  // -------------------------------------------------------------------------
  // fs.watch — primary signal. May fail to attach (file doesn't exist yet)
  // or die mid-way (atomic-save inode swap). Both are tolerated; the poll
  // fallback covers gaps.
  // -------------------------------------------------------------------------
  let fsWatcher = null;
  const tryAttachWatcher = () => {
    if (!existsSync(projectionPath)) return;
    if (fsWatcher) return;
    try {
      fsWatcher = watch(projectionPath, { persistent: false }, (eventType) => {
        // eventType is 'change' | 'rename'. Atomic save fires 'rename'
        // and may then invalidate this watcher; the next poll will
        // detect it and re-attach.
        if (eventType === 'rename') {
          // Tear down the watcher — the underlying inode is gone.
          try { fsWatcher && fsWatcher.close(); } catch { /* noop */ }
          fsWatcher = null;
        }
        fireSoon(eventType === 'rename' ? 'rename' : 'change');
      });
      fsWatcher.on('error', () => {
        // Swallow watcher errors and rely on poll fallback. The watcher
        // will be re-attached on the next poll once the file is back.
        try { fsWatcher && fsWatcher.close(); } catch { /* noop */ }
        fsWatcher = null;
      });
    } catch {
      fsWatcher = null;
    }
  };
  tryAttachWatcher();

  // -------------------------------------------------------------------------
  // Polling — runs every `pollIntervalMs` regardless of watcher health.
  // Tracks the last seen `mtimeMs` and fires the listener on change. Also
  // re-attaches fs.watch if it died (atomic save dropped the inode).
  // -------------------------------------------------------------------------
  let lastMtimeMs = readMtimeSafe(projectionPath);
  let pollTimer = setInterval(() => {
    // Re-attach watcher first so any subsequent fs.watch deliveries can
    // pre-empt this poll's debounce window cleanly.
    if (!fsWatcher) tryAttachWatcher();

    const current = readMtimeSafe(projectionPath);
    if (current === null) {
      // File doesn't exist (yet). Reset baseline so the first appearance
      // counts as a change.
      if (lastMtimeMs !== null) lastMtimeMs = null;
      return;
    }
    if (lastMtimeMs === null || current !== lastMtimeMs) {
      lastMtimeMs = current;
      fireSoon('poll');
    }
  }, pollIntervalMs);
  // Don't keep the event loop alive on the watcher's behalf — the consumer
  // owns liveness via the Disposable.
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  return {
    dispose() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        pendingType = null;
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (fsWatcher) {
        try { fsWatcher.close(); } catch { /* noop */ }
        fsWatcher = null;
      }
    },
  };
}

/**
 * Read the file's `mtimeMs` and return it, or null if the file is missing
 * or unreadable. Never throws — this is the polling-loop hot path and any
 * error must degrade to "no change" rather than crashing the timer.
 */
function readMtimeSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
