/**
 * Unit tests for `lib/init.mjs` — the idempotent storage initializer used
 * by cockpit's Setup Wizard.
 *
 * Coverage:
 *   - Fresh dir: creates parent dir, empty events.jsonl (0 bytes), and a
 *     valid empty projection.json with schema_version=2.
 *   - Re-run: idempotent — existing files preserved, `created.*` flags
 *     reflect what was actually created this call (all false on re-run).
 *   - Permission errors: returns `{ ok: false, error }` without throwing
 *     so the wizard can surface uniformly.
 *   - Custom paths: respects opts.paths.eventsJsonl / projectionJson
 *     overrides (used by integration tests + future cockpit env).
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
      assert.equal(r.created.dir, true);
      assert.equal(r.created.eventsJsonl, true);
      assert.equal(r.created.projectionJson, true);

      const eventsPath = join(root, 'tickets/_logs/sessions-db-events.jsonl');
      const projectionPath = join(root, 'tickets/_logs/sessions-db.json');
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
      const projectionPath = join(root, 'tickets/_logs/sessions-db.json');
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
      // Manually create the directory + events.jsonl, leave projection missing.
      const projDir = join(root, 'tickets/_logs');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'sessions-db-events.jsonl'), '');

      const r = await initProjection({ rootPath: root });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.created.dir, false, 'dir was already there');
      assert.equal(r.created.eventsJsonl, false, 'events.jsonl was already there');
      assert.equal(r.created.projectionJson, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns ok:false (no throw) when rootPath is missing', async () => {
    const r = await initProjection({});
    assert.equal(r.ok, false);
    assert.match(r.error, /rootPath required/);
  });

  it('returns ok:false (no throw) when opts itself is missing', async () => {
    const r = await initProjection();
    assert.equal(r.ok, false);
    assert.match(r.error, /opts required/);
  });

  it('respects opts.paths overrides for both files', async () => {
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
      // Default location should NOT have been created.
      assert.equal(existsSync(join(root, 'tickets/_logs/sessions-db.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns ok:false (no throw) on permission error', async () => {
    // Skip on root user (where chmod is bypassed). CI typically runs as
    // non-root so this is exercised in normal pipelines.
    if (process.getuid && process.getuid() === 0) return;
    const root = mkTmp();
    try {
      // Create the parent dir as read-only so writing inside fails.
      const projDir = join(root, 'tickets/_logs');
      mkdirSync(projDir, { recursive: true });
      chmodSync(projDir, 0o555); // r-x for owner — no write
      try {
        const r = await initProjection({ rootPath: root });
        assert.equal(r.ok, false);
        assert.match(r.error, /initProjection:/);
      } finally {
        // Restore so rmSync can clean up.
        chmodSync(projDir, 0o755);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
