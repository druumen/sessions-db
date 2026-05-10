import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { searchSessions } from '../../cli/find.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';
const SID_D = 'sess_dddddddd-4444-7000-8000-000000000004';

function mkSession(stableId, overrides = {}) {
  return {
    stable_id: stableId,
    alias: null,
    activity_state: 'active',
    outcome: 'open',
    last_progress_at: '2026-05-09T00:00:00.000Z',
    created_at: '2026-05-09T00:00:00.000Z',
    branch_current: null,
    branch_at_start: null,
    cwd: null,
    worktree_path_observed: null,
    worktree_realpath: null,
    parent_session_id: null,
    tasks: [],
    projects: [],
    claude_session_ids: [],
    transcript_files: [],
    ...overrides,
  };
}

function mkProjection(sessions) {
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  return { _meta: { schema_version: 2 }, sessions: byId };
}

describe('find — searchSessions (pure)', () => {
  it('returns all sessions when no filters', () => {
    const proj = mkProjection([
      mkSession(SID_A),
      mkSession(SID_B),
    ]);
    const r = searchSessions(proj, {});
    assert.equal(r.length, 2);
  });

  it('filters by --task (exact membership in tasks[])', () => {
    const proj = mkProjection([
      mkSession(SID_A, { tasks: ['feat-foo.md'] }),
      mkSession(SID_B, { tasks: ['feat-bar.md'] }),
    ]);
    const r = searchSessions(proj, { task: 'feat-foo.md' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_A);
  });

  it('filters by --project (exact membership in projects[])', () => {
    const proj = mkProjection([
      mkSession(SID_A, { projects: ['proj-x'] }),
      mkSession(SID_B, { projects: ['proj-y'] }),
    ]);
    const r = searchSessions(proj, { project: 'proj-y' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_B);
  });

  it('filters by --alias exact match', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'main' }),
      mkSession(SID_B, { alias: 'side' }),
    ]);
    const r = searchSessions(proj, { alias: 'side' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_B);
  });

  it('filters by --branch (matches branch_current OR branch_at_start)', () => {
    const proj = mkProjection([
      mkSession(SID_A, { branch_current: 'feat/x' }),
      mkSession(SID_B, { branch_at_start: 'feat/y' }),
      mkSession(SID_C, { branch_current: 'main' }),
    ]);
    const rA = searchSessions(proj, { branch: 'feat/x' });
    assert.equal(rA.length, 1);
    assert.equal(rA[0].stable_id, SID_A);
    const rB = searchSessions(proj, { branch: 'feat/y' });
    assert.equal(rB.length, 1);
    assert.equal(rB[0].stable_id, SID_B);
  });

  it('filters by --cwd (substring match across cwd / worktree paths)', () => {
    const proj = mkProjection([
      mkSession(SID_A, { cwd: '/Users/x/druumen-wt/foo' }),
      mkSession(SID_B, { worktree_path_observed: '/Users/x/druumen-wt/bar' }),
      mkSession(SID_C, { worktree_realpath: '/Users/x/druumen-wt/baz' }),
    ]);
    const r = searchSessions(proj, { cwd: 'druumen-wt/bar' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_B);
  });

  it('filters by --state', () => {
    const proj = mkProjection([
      mkSession(SID_A, { activity_state: 'active' }),
      mkSession(SID_B, { activity_state: 'idle' }),
      mkSession(SID_C, { activity_state: 'archived' }),
    ]);
    const r = searchSessions(proj, { state: 'idle' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_B);
  });

  it('filters by --outcome', () => {
    const proj = mkProjection([
      mkSession(SID_A, { outcome: 'open' }),
      mkSession(SID_B, { outcome: 'done' }),
      mkSession(SID_C, { outcome: 'blocked' }),
    ]);
    const r = searchSessions(proj, { outcome: 'done' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_B);
  });

  it('AND-combines filters', () => {
    const proj = mkProjection([
      mkSession(SID_A, { activity_state: 'active', outcome: 'open', tasks: ['t1'] }),
      mkSession(SID_B, { activity_state: 'active', outcome: 'done', tasks: ['t1'] }),
      mkSession(SID_C, { activity_state: 'idle', outcome: 'open', tasks: ['t1'] }),
    ]);
    const r = searchSessions(proj, { state: 'active', outcome: 'open', task: 't1' });
    assert.equal(r.length, 1);
    assert.equal(r[0].stable_id, SID_A);
  });

  it('honors --limit', () => {
    const proj = mkProjection([
      mkSession(SID_A, { last_progress_at: '2026-05-09T03:00:00.000Z' }),
      mkSession(SID_B, { last_progress_at: '2026-05-09T02:00:00.000Z' }),
      mkSession(SID_C, { last_progress_at: '2026-05-09T01:00:00.000Z' }),
      mkSession(SID_D, { last_progress_at: '2026-05-09T00:00:00.000Z' }),
    ]);
    const r = searchSessions(proj, { limit: 2 });
    assert.equal(r.length, 2);
    // sorted DESC by last_progress_at
    assert.equal(r[0].stable_id, SID_A);
    assert.equal(r[1].stable_id, SID_B);
  });

  it('returns empty array when no match', () => {
    const proj = mkProjection([mkSession(SID_A)]);
    const r = searchSessions(proj, { task: 'nonexistent' });
    assert.deepEqual(r, []);
  });

  it('handles malformed projection (no sessions key) gracefully', () => {
    const r = searchSessions({}, {});
    assert.deepEqual(r, []);
  });
});

describe('find — searchSessions reads disk projection via loadProjection', () => {
  it('round-trips a tmpdir-backed projection', async () => {
    // This proves the find handler's loadProjection() integration: write a
    // valid projection to disk, then re-read via the same path the run()
    // entrypoint uses.
    const dir = mkdtempSync(join(tmpdir(), 'find-cli-'));
    try {
      const projDir = join(dir, 'tickets/_logs');
      mkdirSync(projDir, { recursive: true });
      const projection = mkProjection([
        mkSession(SID_A, { alias: 'live' }),
      ]);
      writeFileSync(
        join(projDir, 'sessions-db.json'),
        JSON.stringify(projection),
      );
      // Import here to keep the read-only pure test (above) decoupled from
      // file IO during the bulk of cases.
      const { loadProjection } = await import('../../lib/storage.mjs');
      const loaded = await loadProjection({ root: dir });
      const r = searchSessions(loaded, { alias: 'live' });
      assert.equal(r.length, 1);
      assert.equal(r[0].stable_id, SID_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
