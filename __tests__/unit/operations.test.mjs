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
  setName,
  setParent,
  unlinkTask,
} from '../../lib/operations.mjs';
import { MAX_NAME_VALUE_LEN, MAX_OBSERVED_FROM_LEN } from '../../lib/names.mjs';
import { appendEvent, loadProjection, newEvent } from '../../lib/storage.mjs';

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

describe('operations.setName', () => {
  it('writes a name_set event on an arbitrary channel', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({
        stableId: SID_A,
        channel: 'cc_custom_title',
        value: 'typed by hand',
        source: 'human',
        observedFrom: '/t/a.jsonl',
        root,
      });
      assert.equal(r.ok, true, r.error);
      const [event] = eventsLines(root);
      assert.equal(event.op, 'name_set');
      assert.deepEqual(event.payload, {
        channel: 'cc_custom_title',
        value: 'typed by hand',
        source: 'human',
        observed_from: '/t/a.jsonl',
      });
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].display_name, 'typed by hand');
      assert.equal(proj.sessions[SID_A].display_name_channel, 'cc_custom_title');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a channel this build has never heard of', async () => {
    // The write path validates SHAPE, never membership. Refusing an unknown
    // channel here would defeat the point of an open set: adding a namer is
    // supposed to be a non-event.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({
        stableId: SID_A, channel: 'dru_cli_label', value: 'from a future build',
        source: 'plugin', root,
      });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'dru_cli_label');
      assert.equal(entry.value, 'from a future build');
      assert.equal(entry.source, 'plugin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clear records a null-valued entry rather than deleting the channel', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      await setName({ stableId: SID_A, channel: 'cc_custom_title', value: 'temporary', root });
      const r = await setName({ stableId: SID_A, channel: 'cc_custom_title', clear: true, root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'cc_custom_title');
      assert.ok(entry, 'the entry survives the clear');
      assert.equal(entry.value, null);
      assert.equal(entry.set_count, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed input without throwing and without writing', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const bad = [
        { stableId: SID_A, channel: 'has space', value: 'x', root },
        { stableId: SID_A, channel: 'a'.repeat(65), value: 'x', root },
        { stableId: SID_A, channel: 'ok', value: 'x'.repeat(MAX_NAME_VALUE_LEN + 1), root },
        { stableId: SID_A, channel: 'ok', value: 'x', source: 'two words', root },
        { stableId: SID_A, channel: 'ok', root },
        { stableId: SID_A, channel: 'ok', value: 'x', clear: true, root },
        { channel: 'ok', value: 'x', root },
      ];
      for (const opts of bad) {
        const r = await setName(opts);
        assert.equal(r.ok, false, `should have rejected: ${JSON.stringify(opts)}`);
        assert.match(r.error, /setName:/);
      }
      assert.equal(eventsLines(root).length, 0, 'no event written for any rejection');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unknown stable_id before writing', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({ stableId: 'sess_no-such', channel: 'alias', value: 'x', root });
      assert.equal(r.ok, false);
      assert.match(r.error, /stable_id not found/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('operations.setAlias — name model wiring', () => {
  it('keeps writing alias_set, and it still lands on the alias channel', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: SID_A, alias: 'pinned', root });
      assert.equal(r.ok, true, r.error);
      const [event] = eventsLines(root);
      // The legacy op, deliberately: it is the only naming op a pre-0.3.0
      // reducer understands, and `alias` is the one channel a human sets by
      // hand. See lib/operations.setAlias.
      assert.equal(event.op, 'alias_set');
      assert.deepEqual(event.payload, { alias: 'pinned' });
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].alias, 'pinned');
      assert.equal(proj.sessions[SID_A].display_name_channel, 'alias');
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'alias');
      assert.equal(entry.source, 'human', 'authorship comes from the op, not the payload');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an old reducer can still read an alias this version wrote', async () => {
    // The regression this op choice exists to prevent. `loadProjection`
    // rebuilds from the log whenever the cache is missing or corrupt, so a
    // 0.2.x binary on the same machine folds the log without anybody asking
    // it to — and a `name_set` alias comes back as null there.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      assert.equal((await setAlias({ stableId: SID_A, alias: 'survives', root })).ok, true);
      const [event] = eventsLines(root);

      // A stand-in for the pre-0.3.0 reducer: the alias branch as it was,
      // with no knowledge of channels.
      const legacy = { alias: null };
      if (event.op === 'alias_set') {
        const v = event.payload.alias;
        if (v === null) legacy.alias = null;
        else if (typeof v === 'string' && v.length > 0) legacy.alias = v;
      }
      assert.equal(legacy.alias, 'survives');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an alias that is nothing but terminal escapes', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: SID_A, alias: '\u001b[2K\u001b[31m', root });
      assert.equal(r.ok, false);
      assert.match(r.error, /printable/);
      assert.equal(eventsLines(root).length, 0, 'nothing written for a name that is not one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an alias longer than a name may be', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setAlias({ stableId: SID_A, alias: 'x'.repeat(MAX_NAME_VALUE_LEN + 1), root });
      assert.equal(r.ok, false);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('operations.setName — authorship, timestamps, bounds', () => {
  it('defaults source to harvest, not human', async () => {
    // The three defaults in the model used to disagree (`human` here,
    // `harvest` in nameSetPayload and nameChangeFromEvent). `harvest` is the
    // right side: the axis exists so a consumer can ask which names a PERSON
    // gave a session, and a caller that did not say who authored one is by
    // construction reporting something it observed.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({ stableId: SID_A, channel: 'cc_custom_title', value: 'observed', root });
      assert.equal(r.ok, true, r.error);
      assert.equal(eventsLines(root)[0].payload.source, 'harvest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an explicit source still wins', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      await setName({ stableId: SID_A, channel: 'cc_custom_title', value: 'typed', source: 'human', root });
      assert.equal(eventsLines(root)[0].payload.source, 'human');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an observedAt that is not a timestamp, instead of storing the string', async () => {
    // `set_at` is typed `Iso8601|null`. Returning ok and writing "not-a-date"
    // into it made the declared type a lie all the way down to whatever sorts
    // the history view.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({
        stableId: SID_A, channel: 'cc_custom_title', value: 'x',
        observedAt: 'not-a-date', root,
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /ISO 8601/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a real observedAt and carries it into set_at', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({
        stableId: SID_A, channel: 'cc_custom_title', value: 'x',
        observedAt: '2026-08-01T10:00:00.000Z', root,
      });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'cc_custom_title');
      assert.equal(entry.set_at, '2026-08-01T10:00:00.000Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an observedFrom that would not fit, rather than silently dropping it', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await setName({
        stableId: SID_A, channel: 'cc_custom_title', value: 'x',
        observedFrom: 'x'.repeat(MAX_OBSERVED_FROM_LEN + 1), root,
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /observedFrom/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sanitises the value it stores, and refuses one that sanitises to nothing', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const ok = await setName({
        stableId: SID_A, channel: 'cc_custom_title', value: 'redesign\nBM overview', root,
      });
      assert.equal(ok.ok, true, ok.error);
      assert.equal(eventsLines(root)[0].payload.value, 'redesign BM overview');

      const bad = await setName({ stableId: SID_A, channel: 'cc_custom_title', value: '\x1b[2K', root });
      assert.equal(bad.ok, false);
      assert.equal(eventsLines(root).length, 1, 'nothing written for a name that is not one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('running the same setName twice does not invent a rename', async () => {
    // End-to-end version of the reducer property: two distinct events, same
    // naming. The second one is in the log forever, so if the reducer counted
    // it no rebuild could ever take it back.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      await setName({ stableId: SID_A, channel: 'cc_custom_title', value: 'steady', root });
      await setName({ stableId: SID_A, channel: 'cc_custom_title', value: 'steady', root });
      assert.equal(eventsLines(root).length, 2, 'both writes are audited');
      const proj = await loadProjection({ root });
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'cc_custom_title');
      assert.equal(entry.set_count, 1, 'but only one naming happened');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('operations.setAlias — one write, one set', () => {
  it('a single alias write on a root with no projection cache counts once', async () => {
    // The no-race, no-duplicate-command failure: `tryUpdateProjection` appends
    // to the log first, then folds — and with no cache on disk that fold
    // already contains the event it is about to apply. This landed
    // `set_count: 2` for one `alias` command, and deleting the projection
    // cache is a documented-safe operation.
    const root = mkTmp();
    try {
      // Log only, no cache — the state a documented-safe `rm sessions-db.json`
      // leaves behind, and the state every fresh clone starts in.
      await appendEvent(newEvent({
        op: 'session_seen', stable_id: SID_A, payload: { claude_session_id: 'cs-1' },
      }), { root });
      const r = await setAlias({ stableId: SID_A, alias: 'once', root });
      assert.equal(r.ok, true, r.error);
      const proj = await loadProjection({ root });
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'alias');
      assert.equal(entry.set_count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the same alias twice leaves the count at one', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      await setAlias({ stableId: SID_A, alias: 'pinned', root });
      await setAlias({ stableId: SID_A, alias: 'pinned', root });
      const proj = await loadProjection({ root });
      const entry = proj.sessions[SID_A].names.find((n) => n.channel === 'alias');
      assert.equal(entry.set_count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
