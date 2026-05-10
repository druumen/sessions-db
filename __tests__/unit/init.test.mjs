/**
 * Unit tests for `lib/init.mjs` — the idempotent storage initializer used
 * by cockpit's Setup Wizard.
 *
 * Coverage (Day 4 path-resolution-aware):
 *   - Fresh dir: creates parent dir, empty events.jsonl (0 bytes), and a
 *     valid empty projection.json with schema_version=2 — at the canonical
 *     `<rootPath>/sessions-db-{events.jsonl,json}` layout.
 *   - Re-run: idempotent — existing files preserved, `created.*` flags
 *     reflect what was actually created this call (all false on re-run).
 *   - Permission errors: returns `{ ok: false, error }` without throwing
 *     so the wizard can surface uniformly.
 *   - Custom paths: respects opts.paths.eventsJsonl / projectionJson
 *     overrides (legacy form — anchors relative paths against rootPath).
 *   - Day 4 default mode: `initProjection({})` (no rootPath) goes through
 *     `resolveStoragePaths()` chain → `<cwd>/.dru-code/`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjection } from '../../lib/init.mjs';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-init-'));
}

describe('initProjection', () => {
  it('fresh dir → creates parent dir + empty events.jsonl + valid projection.json', async () => {
    const root = mkTmp();
    try {
      const r = await initProjection({ rootPath: root });
      assert.equal(r.ok, true, r.error);
      // `dir` flag tracks "did we mkdir anything?" — for a tmpdir that
      // already exists we may not need a fresh mkdir; only the file flags
      // are load-bearing here.
      assert.equal(r.created.eventsJsonl, true);
      assert.equal(r.created.projectionJson, true);
      // Day 4 layout: rootPath IS the storage dir, files live directly inside.
      assert.equal(r.source, 'arg');

      const eventsPath = join(root, 'sessions-db-events.jsonl');
      const projectionPath = join(root, 'sessions-db.json');
      assert.ok(existsSync(eventsPath));
      assert.ok(existsSync(projectionPath));

      // events.jsonl is 0 bytes (empty file, no header)
      assert.equal(statSync(eventsPath).size, 0);

      // projection.json parses + has the empty-projection shape
      const proj = JSON.parse(readFileSync(projectionPath, 'utf8'));
      assert.equal(proj._meta.schema_version, 2);
      assert.deepEqual(
        proj._meta.fingerprint_versions,
        ['first_human_prompt_v1', 'lineage_prefix_v1'],
      );
      assert.equal(proj._meta.event_count, 0);
      assert.equal(proj._meta.last_event_id, null);
      assert.deepEqual(proj.sessions, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('idempotent re-run preserves existing files and reports created.*=false', async () => {
    const root = mkTmp();
    try {
      const first = await initProjection({ rootPath: root });
      assert.equal(first.ok, true);

      // Mutate the projection so we can detect overwrite.
      const projectionPath = join(root, 'sessions-db.json');
      const sentinel = { _meta: { schema_version: 999, sentinel: 'preserved' }, sessions: { x: 1 } };
      writeFileSync(projectionPath, JSON.stringify(sentinel));

      const second = await initProjection({ rootPath: root });
      assert.equal(second.ok, true);
      assert.equal(second.created.dir, false);
      assert.equal(second.created.eventsJsonl, false);
      assert.equal(second.created.projectionJson, false);

      // The sentinel must survive — re-init NEVER overwrites.
      const after = JSON.parse(readFileSync(projectionPath, 'utf8'));
      assert.equal(after._meta.sentinel, 'preserved');
      assert.equal(after._meta.schema_version, 999);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('partial state: only events.jsonl exists → only projection.json is created', async () => {
    const root = mkTmp();
    try {
      // Manually create events.jsonl in-place (rootPath IS the storage dir
      // under Day 4 semantics); leave projection.json missing.
      writeFileSync(join(root, 'sessions-db-events.jsonl'), '');

      const r = await initProjection({ rootPath: root });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.created.eventsJsonl, false, 'events.jsonl was already there');
      assert.equal(r.created.projectionJson, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Day 4 default: initProjection({}) goes through resolver → cwd/.dru-code/', async () => {
    // Run with cwd pinned to a tmpdir so the default chain lands inside it
    // instead of polluting the worktree. We cd via a child process style
    // by spawning a subprocess... actually simpler: just mutate process.cwd
    // via process.chdir and restore in finally.
    const root = mkTmp();
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      const r = await initProjection({});
      assert.equal(r.ok, true, r.error);
      assert.equal(r.source, 'default');
      // Files should land in <root>/.dru-code/ because no existing storage
      // is reachable via ascend and no env var is set.
      assert.ok(existsSync(join(root, '.dru-code', 'sessions-db-events.jsonl')));
      assert.ok(existsSync(join(root, '.dru-code', 'sessions-db.json')));
    } finally {
      process.chdir(origCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns ok:false (no throw) when opts itself is missing', async () => {
    const r = await initProjection();
    assert.equal(r.ok, false);
    assert.match(r.error, /opts required/);
  });

  it('respects opts.paths overrides for both files (legacy form)', async () => {
    const root = mkTmp();
    try {
      const r = await initProjection({
        rootPath: root,
        paths: {
          eventsJsonl: 'custom/events.jsonl',
          projectionJson: 'custom/projection.json',
        },
      });
      assert.equal(r.ok, true, r.error);
      assert.ok(existsSync(join(root, 'custom/events.jsonl')));
      assert.ok(existsSync(join(root, 'custom/projection.json')));
      // Default Day 4 location should NOT have been created.
      assert.equal(existsSync(join(root, 'sessions-db.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Day 4 env-var mode: initProjection({}) honors DRUUMEN_SESSIONS_DB_ROOT', async () => {
    // When the env var is set and no opts.rootPath is supplied, the
    // resolver picks the env root. initProjection must follow that pick
    // so cockpit's Setup-Wizard-with-pinned-env workflow lands at the
    // expected location.
    const root = mkTmp();
    const origEnv = process.env.DRUUMEN_SESSIONS_DB_ROOT;
    try {
      process.env.DRUUMEN_SESSIONS_DB_ROOT = root;
      const r = await initProjection({});
      assert.equal(r.ok, true, r.error);
      assert.equal(r.source, 'env');
      assert.ok(existsSync(join(root, 'sessions-db-events.jsonl')));
      assert.ok(existsSync(join(root, 'sessions-db.json')));
    } finally {
      if (origEnv === undefined) delete process.env.DRUUMEN_SESSIONS_DB_ROOT;
      else process.env.DRUUMEN_SESSIONS_DB_ROOT = origEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns ok:false (no throw) on permission error', async () => {
    // Skip on root user (where chmod is bypassed). CI typically runs as
    // non-root so this is exercised in normal pipelines.
    if (process.getuid && process.getuid() === 0) return;
    const root = mkTmp();
    try {
      // Make the storage dir itself (which IS rootPath under Day 4) read-only
      // so writing inside fails. tmpdir already created the dir; we just need
      // to flip perms.
      chmodSync(root, 0o555); // r-x for owner — no write
      try {
        const r = await initProjection({ rootPath: root });
        assert.equal(r.ok, false);
        assert.match(r.error, /initProjection:/);
      } finally {
        // Restore so rmSync can clean up.
        chmodSync(root, 0o755);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
