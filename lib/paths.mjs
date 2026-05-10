/**
 * Centralized storage-path resolution for sessions-db.
 *
 * Prior to Day 4, every storage primitive (`appendEvent`, `loadProjection`,
 * `tryUpdateProjection`, `recordSessionSeen`, `initProjection`,
 * `watchProjection`) hand-rolled its own "anchor opts.paths against opts.root
 * or fall back to PATHS + cwd" path-joining logic. That worked while there
 * was a single canonical layout (`tickets/_logs/`) and a single consumer
 * (this monorepo), but it doesn't survive cockpit-marketplace users who:
 *   - don't have `tickets/_logs/` (no monorepo)
 *   - want a product-neutral default (`.dru-code/`)
 *   - need an env-var override for VS Code workspace overrides
 *   - might call from inside a child workspace dir and expect "find existing
 *     storage upward" instead of accidentally creating a parallel one
 *
 * `resolveStoragePaths(opts)` collapses all five priorities into one entry
 * point. First hit wins:
 *
 *   1. opts.rootPath — explicit caller arg (highest priority; tests + library
 *      consumers that already know exactly where storage lives)
 *   2. process.env.DRUUMEN_SESSIONS_DB_ROOT — env var override (cockpit
 *      Setup Wizard writes this, CI overrides it, ops can pin during incidents)
 *   3. cwd-ascend (bounded) for an existing `tickets/_logs/sessions-db.json`
 *      — preserves the druumen monorepo experience: running any sessions-db
 *      command from anywhere inside the worktree finds the canonical
 *      tickets/_logs/ root just like the previous hand-rolled cwd-anchor did.
 *   4. cwd-ascend (bounded) for an existing `.dru-code/sessions-db.json` —
 *      the new convention for fresh installs that have already been
 *      initialized once.
 *   5. Default new: `<cwd>/.dru-code/` — what fresh `initProjection({})`
 *      lands when no existing storage is found. Cockpit marketplace's first
 *      install creates this dir.
 *
 * Layout invariant inside `<root>/`:
 *   - sessions-db-events.jsonl  — append-only SSoT
 *   - sessions-db.json          — projection cache
 *   - sessions-db.json.lock     — exclusive-create lockfile
 *
 * The same three filenames are used for both druumen-monorepo
 * (`tickets/_logs/`) and `.dru-code/` layouts so callers never need a
 * layout-conditional path computation.
 *
 * Why an ascend bound (MAX_ASCEND_DEPTH=12)? Walking to filesystem `/` is
 * slow on networked mounts and pointless — anyone keeping their workspace
 * 12 directories deep is doing something unusual and should set
 * `DRUUMEN_SESSIONS_DB_ROOT` explicitly. The bound caps the worst-case stat
 * count at 12 × 2 (two candidate file checks per level) = 24 stats per call.
 *
 * Zero new runtime deps: `node:fs`, `node:path`. Same as the rest of lib/.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Hard cap on cwd-ascend depth. Twelve levels is generous — a typical
 * worktree depth is 1-3, monorepos may go to 5-6. Pinning at 12 means the
 * worst-case stat budget is 24 (two candidate paths × 12 levels) before
 * we fall through to the default. Set deliberately conservative so the
 * resolver never accidentally walks to `/` on a slow networked mount.
 */
export const MAX_ASCEND_DEPTH = 12;

/**
 * The three on-disk filenames (relative to whichever root the resolver
 * picks). Frozen so callers can't accidentally mutate. Exported for tests
 * + the rare library consumer that wants to know the canonical names.
 */
export const STORAGE_FILENAMES = Object.freeze({
  eventsJsonl: 'sessions-db-events.jsonl',
  projectionJson: 'sessions-db.json',
  lockFile: 'sessions-db.json.lock',
});

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
export function resolveStoragePaths(opts = {}) {
  // ----- Priority 1: explicit opts.rootPath -----
  // Tests + library consumers that already pinned the location pass this.
  // Resolved against process.cwd() so a relative override (`./tmp/db`) still
  // produces an absolute path the rest of the library can use.
  if (typeof opts.rootPath === 'string' && opts.rootPath.length > 0) {
    const root = resolve(opts.rootPath);
    return { root, ...buildFilePaths(root), source: 'arg' };
  }

  // ----- Priority 2: env var -----
  // DRUUMEN_SESSIONS_DB_ROOT is the documented escape hatch for ops /
  // cockpit Setup Wizard / CI matrix runs. Empty string is treated as
  // "not set" so `DRUUMEN_SESSIONS_DB_ROOT=` in a half-configured env file
  // doesn't silently send writes to `/sessions-db-events.jsonl`.
  const envRoot = process.env.DRUUMEN_SESSIONS_DB_ROOT;
  if (typeof envRoot === 'string' && envRoot.length > 0) {
    const root = resolve(envRoot);
    return { root, ...buildFilePaths(root), source: 'env' };
  }

  // ----- Priorities 3 + 4: cwd-ascend for existing storage -----
  // We walk upward from opts.cwd (or process.cwd) checking for either a
  // legacy druumen-monorepo `tickets/_logs/sessions-db.json` (priority 3)
  // OR a new-convention `.dru-code/sessions-db.json` (priority 4). At each
  // level the legacy check runs first — when both exist somehow, the
  // existing-data location wins so we never silently bifurcate writes.
  const startCwd = resolve(
    typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : process.cwd(),
  );
  const found = ascendForExistingDb(startCwd);
  if (found) {
    return { root: found.root, ...buildFilePaths(found.root), source: found.source };
  }

  // ----- Priority 5: new default `<cwd>/.dru-code/` -----
  // Fresh-install case. `initProjection` will mkdir this; until it does,
  // the path is virtual (just where future writes will land).
  const defaultRoot = join(startCwd, '.dru-code');
  return { root: defaultRoot, ...buildFilePaths(defaultRoot), source: 'default' };
}

/**
 * Build absolute file paths from a root directory. Assumes `root` is already
 * absolute (callers in this module always resolve before calling).
 *
 * @param {string} root
 * @returns {{ eventsJsonl: string, projectionJson: string, lockFile: string }}
 */
function buildFilePaths(root) {
  return {
    eventsJsonl: join(root, STORAGE_FILENAMES.eventsJsonl),
    projectionJson: join(root, STORAGE_FILENAMES.projectionJson),
    lockFile: join(root, STORAGE_FILENAMES.lockFile),
  };
}

/**
 * Walk upward from `startCwd` looking for an existing sessions-db storage
 * dir. Returns `{ root, source }` on first hit, null after MAX_ASCEND_DEPTH
 * levels or when reaching the filesystem root.
 *
 * Order at each level:
 *   - tickets/_logs/sessions-db.json (druumen-monorepo legacy)
 *   - .dru-code/sessions-db.json (new convention)
 *
 * Why projection-file existence (not directory existence)? An empty
 * `tickets/_logs/` or `.dru-code/` directory could legitimately predate
 * sessions-db (e.g. another tool created it). Using the projection file as
 * the existence signal guarantees we only adopt locations that already have
 * sessions-db state — never sibling tools' storage dirs.
 *
 * @param {string} startCwd absolute path
 * @returns {{ root: string, source: 'tickets-logs' | 'dru-code' } | null}
 */
function ascendForExistingDb(startCwd) {
  let cwd = startCwd;
  for (let depth = 0; depth < MAX_ASCEND_DEPTH; depth++) {
    // Priority 3: druumen monorepo convention
    const ticketsLogsRoot = join(cwd, 'tickets', '_logs');
    if (existsSync(join(ticketsLogsRoot, STORAGE_FILENAMES.projectionJson))) {
      return { root: ticketsLogsRoot, source: 'tickets-logs' };
    }
    // Priority 4: .dru-code/ convention
    const druCodeRoot = join(cwd, '.dru-code');
    if (existsSync(join(druCodeRoot, STORAGE_FILENAMES.projectionJson))) {
      return { root: druCodeRoot, source: 'dru-code' };
    }
    // Stop at filesystem root — `path.dirname('/') === '/'` on POSIX,
    // and on Windows `path.dirname('C:\\') === 'C:\\'`. Either way the
    // parent === self loop guard catches it.
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}

/**
 * Helper for callers that already have a fully-resolved root and want to
 * compute file paths (tests, custom integrations). Public so consumers can
 * mirror the layout invariant without importing internal helpers.
 *
 * @param {string} root absolute or relative; resolved against cwd if relative
 * @returns {{ root: string, eventsJsonl: string, projectionJson: string, lockFile: string }}
 */
export function pathsFromRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('pathsFromRoot: root must be a non-empty string');
  }
  const abs = isAbsolute(root) ? root : resolve(root);
  return { root: abs, ...buildFilePaths(abs) };
}
