/**
 * Idempotent storage initializer for sessions-db.
 *
 * `initProjection({ rootPath })` is the entry point used by cockpit's Setup
 * Wizard (and any other library consumer) to bootstrap the on-disk layout
 * before the first `recordSessionSeen` / CLI write lands. Concretely it:
 *
 *   - mkdir -p the parent directory for `tickets/_logs/` (or whatever
 *     `paths.eventsJsonl` resolves to)
 *   - create an empty (0-byte) `events.jsonl` if missing
 *   - create a valid empty `projection.json` (with `_meta.schema_version =
 *     2`, fingerprint_versions, event_count = 0, last_event_id = null,
 *     sessions = {}) if missing
 *
 * The function is **idempotent**: calling it twice in a row leaves the
 * second-call return value's `created.*` flags all `false` to indicate
 * that the existing files were respected. Existing content is NEVER
 * overwritten — the wizard MUST be safe to re-run.
 *
 * Failure mode: when permission / disk errors prevent creation we return
 * `{ ok: false, error }` instead of throwing. That mirrors the rest of the
 * library API (operations.mjs / tryUpdateProjection), so the wizard can
 * surface errors uniformly.
 *
 * Why split this from storage.mjs? `loadProjection` already does a "create
 * if missing → empty projection" path implicitly via rebuild-from-events,
 * but it never persists that empty projection. The wizard needs visible
 * on-disk artifacts so subsequent tools (file watchers, telemetry probes)
 * have something to attach to.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PATHS } from './storage.mjs';

const SCHEMA_VERSION = 2;
const FINGERPRINT_VERSIONS = ['first_human_prompt_v1', 'lineage_prefix_v1'];

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
export async function initProjection(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'initProjection: opts required' };
  }
  const { rootPath } = opts;
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    return { ok: false, error: 'initProjection: rootPath required' };
  }

  const pathOverrides = opts.paths ?? {};
  const eventsRel = pathOverrides.eventsJsonl ?? PATHS.eventsJsonl;
  const projectionRel = pathOverrides.projectionJson ?? PATHS.projectionJson;
  // Anchor each rel-path against rootPath unless it's already absolute. The
  // library treats absolute paths as escape hatches (e.g. tests that point
  // at a tmpdir explicitly).
  const abs = (p) => (p.startsWith('/') ? p : `${rootPath}/${p}`);
  const eventsPath = abs(eventsRel);
  const projectionPath = abs(projectionRel);

  // Both files share a parent dir under tickets/_logs/. Compute the deeper
  // of the two so we cover both even with custom path overrides.
  const dirsToCreate = new Set([dirname(eventsPath), dirname(projectionPath)]);

  const created = { dir: false, eventsJsonl: false, projectionJson: false };
  try {
    for (const dir of dirsToCreate) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        created.dir = true;
      }
    }
    if (!existsSync(eventsPath)) {
      // Touch — empty file (0 bytes). loadEvents reads this fine; the
      // first `appendEvent` call will populate it.
      writeFileSync(eventsPath, '', { flag: 'wx' });
      created.eventsJsonl = true;
    }
    if (!existsSync(projectionPath)) {
      const empty = emptyProjectionLiteral();
      // `flag: 'wx'` so a concurrent initializer doesn't clobber a live
      // projection. existsSync check + wx flag is belt-and-suspenders;
      // the existsSync race would otherwise surface as EEXIST, which we
      // re-translate as "not created" rather than an error.
      try {
        writeFileSync(
          projectionPath,
          JSON.stringify(empty, null, 2),
          { flag: 'wx' },
        );
        created.projectionJson = true;
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          // Lost the race; another initializer beat us. That's fine —
          // the file exists, the contract holds.
          created.projectionJson = false;
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `initProjection: ${err && err.message ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    created,
    paths: { eventsJsonl: eventsPath, projectionJson: projectionPath },
  };
}

/**
 * Build the empty projection literal we serialize for fresh initialization.
 *
 * Kept inline (rather than importing `emptyProjection()` from
 * `projection.mjs`) so the on-disk shape is decoupled from the in-memory
 * reducer — `_meta.updated` here is set to a real timestamp so consumers
 * have a non-null marker, while `applyEvent`'s `updated` is event-driven.
 */
function emptyProjectionLiteral() {
  return {
    _meta: {
      schema_version: SCHEMA_VERSION,
      fingerprint_versions: [...FINGERPRINT_VERSIONS],
      updated: new Date().toISOString(),
      event_count: 0,
      last_event_id: null,
    },
    sessions: {},
  };
}
