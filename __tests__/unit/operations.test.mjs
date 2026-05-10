/**
 * Unit tests for `lib/operations.mjs` — the validated, structured-result
 * library API surface that wraps storage primitives.
 *
 * Each test plants a tmpdir-isolated projection, calls the operation, and
 * asserts the result shape + side effects on disk (events.jsonl + projection
 * cache). We also validate that bad input returns `{ ok: false, error }`
 * INSTEAD of throwing — that's the library API contract.
 *
 * Note: the operations.mjs functions are also exercised indirectly through
 * the CLI write-handlers tests; those validate the human-facing surface.
 * These tests focus on the LIBRARY surface (return shape, validation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeSession,
  linkTask,
  runSweep,
  setAlias,
  setParent,
  unlinkTask,
} from '../../lib/operations.mjs';
import { loadProjection } from '../../lib/storage.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';

const DAY_MS = 24 * 60 * 60 * 1000;

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-ops-'));
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function plantProjection(root, sessions, meta = {}) {
  const projDir = join(root, 'tickets/_logs');
  mkdirSync(projDir, { recursive: true });
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  const projection = {
    _meta: {
      schema_version: 2,
      fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
      updated: new Date().toISOString(),
      event_count: 0,
      last_event_id: null,
      ...meta,
    },
    sessions: byId,
  };
  writeFileSync(join(projDir, 'sessions-db.json'), JSON.stringify(projection));
  return projection;
}

function mkSession(stableId, overrides = {}) {
  return {
    stable_id: stableId,
    alias: null,
    activity_state: 'active',
    outcome: 'open',
    last_progress_at: isoDaysAgo(0),
    created_at: isoDaysAgo(0),
    branch_current: null,
    branch_at_start: null,
    parent_session_id: null,
    parent_candidate_ids: [],
    cwd: null,
    tasks: [],
    projects: [],
    claude_session_ids: [],
    transcript_files: [],
    fingerprints: { first_human_prompt_v1: null, lineage_prefix_v1: null },
    ...overrides,
  };
}

function eventsLines(root) {
  const p = join(root, 'tickets/_logs/sessions-db-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// setAlias
// ---------------------------------------------------------------------------
describe('operations.setAlias', () => {
  it('sets a fresh alias on a known session and returns event_id', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: SID_A, alias: 'demo', root });
      assert.equal(r.ok, true, r.error);
      assert.match(r.event_id, /^evt_/);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].alias, 'demo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clear: true sets alias to null', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { alias: 'old' })]);
      const r = await setAlias({ stableId: SID_A, clear: true, root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].alias, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects (no throw) when both alias and clear given', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: SID_A, alias: 'x', clear: true, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /mutually exclusive/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when neither alias nor clear given', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: SID_A, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /provide alias or clear/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns stable_id-not-found error for unknown session', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: 'sess_no-such', alias: 'x', root });
      assert.equal(r.ok, false);
      assert.match(r.error, /stable_id not found/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// linkTask / unlinkTask
// ---------------------------------------------------------------------------
describe('operations.linkTask', () => {
  it('adds tasks + projects to the session', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await linkTask({
        stableId: SID_A, tasks: ['t1.md'], projects: ['p1'], root,
      });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t1.md']);
      assert.deepEqual(proj.sessions[SID_A].projects, ['p1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('idempotent dedup — re-linking the same task is a projection-no-op', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { tasks: ['t1.md'] })]);
      const r = await linkTask({ stableId: SID_A, tasks: ['t1.md'], root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t1.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when both tasks and projects empty', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await linkTask({ stableId: SID_A, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /at least one task or project/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a single string for tasks (coerces to array)', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await linkTask({ stableId: SID_A, tasks: 't-single.md', root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t-single.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('operations.unlinkTask', () => {
  it('removes named tasks via session_unlink', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { tasks: ['t1', 't2'] })]);
      const r = await unlinkTask({ stableId: SID_A, tasks: ['t1'], root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t2']);
      const events = eventsLines(root);
      assert.equal(events[0].op, 'session_unlink');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removing a non-existent task is a projection-no-op (audit event still written)', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { tasks: ['t1'] })]);
      const r = await unlinkTask({ stableId: SID_A, tasks: ['nope.md'], root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t1']);
      // Audit event is still appended — operator intent is preserved.
      assert.equal(eventsLines(root).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// setParent — cycle detection is the load-bearing test here.
// ---------------------------------------------------------------------------
describe('operations.setParent', () => {
  it('sets parent_session_id', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A), mkSession(SID_B)]);
      const r = await setParent({ childId: SID_A, parentId: SID_B, root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, SID_B);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clear: true clears parent', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B),
      ]);
      const r = await setParent({ childId: SID_A, clear: true, root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects 1-cycle (self-parent)', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setParent({ childId: SID_A, parentId: SID_A, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /cannot be the same/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects 2-hop cycle: existing A→B + setParent B A', async () => {
    // This is the load-bearing test for the multi-hop cycle defense
    // (mirrors the CLI handler's regression guard from P4 round-1).
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A),
        mkSession(SID_B, { parent_session_id: SID_A }),
      ]);
      const r = await setParent({ childId: SID_A, parentId: SID_B, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /would create a cycle/);
      assert.match(r.error, new RegExp(`reaches child ${SID_A}`));
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects 3-hop cycle: A→B→C, then setParent C A', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B, { parent_session_id: SID_C }),
        mkSession(SID_C),
      ]);
      const r = await setParent({ childId: SID_C, parentId: SID_A, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /would create a cycle/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-cyclic re-parent across deep chain still succeeds', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B, { parent_session_id: SID_C }),
        mkSession(SID_C),
      ]);
      // Re-parent A from B to C — C has no parent so no cycle risk.
      const r = await setParent({ childId: SID_A, parentId: SID_C, root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, SID_C);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns stable-id-not-found when parent is unknown', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setParent({ childId: SID_A, parentId: 'sess_no-such', root });
      assert.equal(r.ok, false);
      assert.match(r.error, /stable_id not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// closeSession
// ---------------------------------------------------------------------------
describe('operations.closeSession', () => {
  it('sets outcome + closed_at + closed_reason', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await closeSession({
        stableId: SID_A, outcome: 'done', reason: 'merged', root,
      });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].outcome, 'done');
      assert.equal(proj.sessions[SID_A].closed_reason, 'merged');
      assert.ok(proj.sessions[SID_A].closed_at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid outcome', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await closeSession({ stableId: SID_A, outcome: 'bogus', root });
      assert.equal(r.ok, false);
      assert.match(r.error, /must be one of/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('outcome=open re-opens a previously-closed session', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, {
          outcome: 'done',
          closed_at: '2026-05-09T00:00:00Z',
          closed_reason: 'old',
        }),
      ]);
      const r = await closeSession({
        stableId: SID_A, outcome: 'open', reason: '(reopened)', root,
      });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].outcome, 'open');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runSweep
// ---------------------------------------------------------------------------
describe('operations.runSweep', () => {
  it('dryRun: true returns plan without writing events', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(50) }),
      ]);
      const r = await runSweep({ root, dryRun: true });
      assert.equal(r.ok, true);
      assert.equal(r.dryRun, true);
      assert.equal(r.transitions.length, 1);
      assert.equal(r.transitions[0].to_state, 'archived');
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('apply path writes one event per transition + summary fields', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(2) }),    // stays
        mkSession(SID_B, { last_progress_at: isoDaysAgo(20) }),   // → idle
        mkSession(SID_C, {
          activity_state: 'idle',
          last_progress_at: isoDaysAgo(45),
        }),                                                        // → archived
      ]);
      const r = await runSweep({ root });
      assert.equal(r.ok, true);
      assert.equal(r.summary.total, 2);
      assert.equal(r.summary.applied, 2);
      assert.equal(r.summary.failed, 0);
      assert.equal(r.summary.to_idle, 1);
      assert.equal(r.summary.to_archived, 1);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].activity_state, 'active');
      assert.equal(proj.sessions[SID_B].activity_state, 'idle');
      assert.equal(proj.sessions[SID_C].activity_state, 'archived');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('idempotent: second run on same projection yields zero transitions', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(20) }),
      ]);
      const r1 = await runSweep({ root });
      assert.equal(r1.summary.applied, 1);
      const r2 = await runSweep({ root });
      assert.equal(r2.summary.total, 0);
      assert.equal(r2.summary.applied, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects idleThresholdDays <= 0 with structured error', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, []);
      const r = await runSweep({ root, idleThresholdDays: 0 });
      assert.equal(r.ok, false);
      assert.match(r.error, /must be a positive number/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects archiveThresholdDays < idleThresholdDays', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, []);
      const r = await runSweep({
        root, idleThresholdDays: 14, archiveThresholdDays: 7,
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /must be >=/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
