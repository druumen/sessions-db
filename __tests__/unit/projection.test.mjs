import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  emptyProjection,
  emptySession,
  rebuildFromEvents,
} from '../projection.mjs';

const TS_A = '2026-05-09T10:00:00.000Z';
const TS_B = '2026-05-09T10:05:00.000Z';
const TS_C = '2026-05-09T10:10:00.000Z';
const TS_D = '2026-05-09T11:00:00.000Z';

const SID = 'sess_01970000-0000-7000-8000-000000000001';
const SID_2 = 'sess_01970000-0000-7000-8000-000000000002';

function evt(op, ts, payload, idSuffix = 'a') {
  return {
    ts,
    event_id: `evt_test-${ts}-${idSuffix}`,
    op,
    stable_id: SID,
    payload: payload ?? {},
  };
}

describe('projection.mjs', () => {
  describe('emptyProjection / emptySession', () => {
    it('emptyProjection has correct meta defaults', () => {
      const p = emptyProjection();
      assert.equal(p._meta.schema_version, 2);
      assert.deepEqual(p._meta.fingerprint_versions, [
        'first_human_prompt_v1',
        'lineage_prefix_v1',
      ]);
      assert.equal(p._meta.event_count, 0);
      assert.equal(p._meta.last_event_id, null);
      assert.equal(p._meta.updated, null);
      assert.deepEqual(p.sessions, {});
    });

    it('emptySession populates v0.2 fields with sane defaults', () => {
      const s = emptySession(SID, TS_A);
      assert.equal(s.stable_id, SID);
      assert.equal(s.alias, null);
      assert.deepEqual(s.claude_session_ids, []);
      assert.deepEqual(s.transcript_files, []);
      assert.deepEqual(s.fingerprints, {
        first_human_prompt_v1: null,
        lineage_prefix_v1: null,
      });
      assert.equal(s.parent_session_id, null);
      assert.deepEqual(s.parent_candidate_ids, []);
      assert.deepEqual(s.tasks, []);
      assert.deepEqual(s.projects, []);
      assert.equal(s.activity_state, 'active');
      assert.equal(s.outcome, 'open');
      assert.equal(s.closed_at, null);
      assert.equal(s.closed_reason, null);
      assert.equal(s.created_at, TS_A);
      assert.equal(s.last_progress_at, TS_A);
      assert.equal(s.first_prompt_preview, null);
    });
  });

  describe('session_seen reducer', () => {
    it('creates a new session record on first sight', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, {
        claude_session_id: 'cs-1',
        branch_at_start: 'main',
        branch_current: 'main',
        head_at_start: 'abc',
        head_last_seen: 'abc',
        worktree_path_observed: '/tmp/wt',
        worktree_realpath: '/tmp/wt',
        transcript_file: { path: '/t/a.jsonl', first_uuid: 'u1', last_uuid: 'u2', size: 100, mtime: 1, status: 'ok' },
        fingerprints: { first_human_prompt_v1: 'fp1', lineage_prefix_v1: 'lp1' },
        first_prompt_preview: 'hello world',
        cwd: '/tmp/wt',
      }));
      const s = p.sessions[SID];
      assert.deepEqual(s.claude_session_ids, ['cs-1']);
      assert.equal(s.transcript_files.length, 1);
      assert.equal(s.transcript_files[0].path, '/t/a.jsonl');
      assert.equal(s.fingerprints.first_human_prompt_v1, 'fp1');
      assert.equal(s.fingerprints.lineage_prefix_v1, 'lp1');
      assert.equal(s.branch_at_start, 'main');
      assert.equal(s.branch_current, 'main');
      assert.equal(s.head_at_start, 'abc');
      assert.equal(s.head_last_seen, 'abc');
      assert.equal(s.first_prompt_preview, 'hello world');
      assert.equal(s.cwd, '/tmp/wt');
      assert.equal(s.created_at, TS_A);
      assert.equal(s.last_progress_at, TS_A);
    });

    it('second session_seen with new claude_session_id appends + updates last_progress_at', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, {
        claude_session_id: 'cs-1',
        transcript_file: { path: '/t/a.jsonl', size: 100 },
        fingerprints: { first_human_prompt_v1: 'fp1' },
        branch_at_start: 'main',
        head_at_start: 'abc',
        first_prompt_preview: 'first',
        cwd: '/tmp/wt',
      }));
      applyEvent(p, evt('session_seen', TS_B, {
        claude_session_id: 'cs-2',
        transcript_file: { path: '/t/a.jsonl', size: 200 },     // same path → dedup-merge
        fingerprints: { first_human_prompt_v1: 'fpX' },         // first-wins → ignored
        branch_at_start: 'feature',                              // first-wins → ignored
        head_at_start: 'def',                                    // first-wins → ignored
        branch_current: 'feature',                               // last-wins → updated
        head_last_seen: 'def',                                   // last-wins → updated
        first_prompt_preview: 'second',                          // first-wins → ignored
      }));
      const s = p.sessions[SID];
      assert.deepEqual(s.claude_session_ids, ['cs-1', 'cs-2']);
      assert.equal(s.transcript_files.length, 1, 'transcript_files dedup by path');
      assert.equal(s.transcript_files[0].size, 200, 'merged transcript_file took newer size');
      assert.equal(s.fingerprints.first_human_prompt_v1, 'fp1', 'first fingerprint preserved');
      assert.equal(s.branch_at_start, 'main', 'first branch_at_start preserved');
      assert.equal(s.head_at_start, 'abc', 'first head_at_start preserved');
      assert.equal(s.branch_current, 'feature', 'last-wins branch_current updated');
      assert.equal(s.head_last_seen, 'def', 'last-wins head_last_seen updated');
      assert.equal(s.first_prompt_preview, 'first', 'first prompt_preview preserved');
      assert.equal(s.last_progress_at, TS_B, 'last_progress_at advanced to TS_B');
      assert.equal(s.created_at, TS_A, 'created_at unchanged');
    });

    it('repeated identical session_seen does not duplicate claude_session_ids', () => {
      const p = emptyProjection();
      const event = evt('session_seen', TS_A, {
        claude_session_id: 'cs-1',
        transcript_file: { path: '/t/a.jsonl' },
      });
      applyEvent(p, event);
      applyEvent(p, { ...event, ts: TS_B, event_id: 'evt_test-b' });
      assert.deepEqual(p.sessions[SID].claude_session_ids, ['cs-1']);
      assert.equal(p.sessions[SID].transcript_files.length, 1);
    });
  });

  describe('session_seen reducer — P3 identity fields', () => {
    it('identity_resolution payload is stored on the session (last-write-wins)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, {
        claude_session_id: 'cs-1',
        identity_resolution: { source: 'minted', confidence: 'minted', matched: {} },
      }));
      assert.equal(p.sessions[SID].identity_resolution.source, 'minted');
      // Second event with a different resolution overwrites (latest wins).
      applyEvent(p, evt('session_seen', TS_B, {
        claude_session_id: 'cs-2',
        identity_resolution: { source: 'transcript_lineage', confidence: 'high', matched: { matched_last_uuid: 'u1' } },
      }));
      assert.equal(p.sessions[SID].identity_resolution.source, 'transcript_lineage');
      assert.equal(p.sessions[SID].identity_resolution.matched.matched_last_uuid, 'u1');
    });

    it('parent_candidate_ids append + dedup by stable_id across multiple session_seen events', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, {
        claude_session_id: 'cs-1',
        parent_candidate_ids: [
          { stable_id: SID_2, source: 'fingerprint', confidence: 'low', reason: { fingerprints_matched: ['first_human_prompt_v1'] } },
        ],
      }));
      assert.equal(p.sessions[SID].parent_candidate_ids.length, 1);
      // Same stable_id observed again — dedup, no growth.
      applyEvent(p, evt('session_seen', TS_B, {
        claude_session_id: 'cs-2',
        parent_candidate_ids: [
          { stable_id: SID_2, source: 'fingerprint', confidence: 'low', reason: { fingerprints_matched: ['lineage_prefix_v1'] } },
          { stable_id: 'sess_01970000-0000-7000-8000-000000000003', source: 'fingerprint', confidence: 'low', reason: {} },
        ],
      }));
      const cands = p.sessions[SID].parent_candidate_ids;
      assert.equal(cands.length, 2, 'SID_2 already present → dedup; new id appended');
      assert.equal(cands[0].stable_id, SID_2);
      // First-write-wins for the candidate object — original reason preserved.
      assert.deepEqual(cands[0].reason.fingerprints_matched, ['first_human_prompt_v1']);
      assert.equal(cands[1].stable_id, 'sess_01970000-0000-7000-8000-000000000003');
    });

    it('emptySession defaults identity_resolution to null', () => {
      const s = emptySession(SID, TS_A);
      assert.equal(s.identity_resolution, null);
    });

    it('rebuild from events with no identity_resolution payload does not crash (backward compat)', () => {
      const p = rebuildFromEvents([
        evt('session_seen', TS_A, { claude_session_id: 'cs-1' }), // no identity_resolution
      ]);
      assert.equal(p.sessions[SID].identity_resolution, null);
    });
  });

  describe('session_link reducer', () => {
    it('merges and dedupes tasks and projects', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1', 't2'], projects: ['p1'] }));
      applyEvent(p, evt('session_link', TS_B, { tasks: ['t2', 't3'], projects: ['p1', 'p2'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1', 't2', 't3']);
      assert.deepEqual(p.sessions[SID].projects, ['p1', 'p2']);
    });

    it('ignores empty / non-string entries', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['', null, 't1', 42, undefined] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1']);
    });

    // ---- codex P5 round-1 fix: P4-era `payload.remove=true` migration -------

    it('P4 migration: ignores legacy session_link events with payload.remove=true', () => {
      // Replay a P4-era events.jsonl segment: operator first added t1, then
      // tried `link --remove --task t1` which under P4 emitted a
      // session_link event with `payload.remove=true` AND `tasks: ['t1']`
      // (the reducer ignored remove and would have re-added t1). Under P5
      // we MUST treat that legacy marker as a no-op so rebuild does not
      // silently re-add tasks the operator wanted gone.
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1', 't2'] }));
      // Operator removed t1 via P5 (canonical path):
      applyEvent(p, evt('session_unlink', TS_B, { tasks: ['t1'] }));
      // P4-era marker that historically would re-add t1 — must be ignored:
      applyEvent(p, evt('session_link', TS_C, {
        remove: true,
        tasks: ['t1'],
      }));
      assert.deepEqual(p.sessions[SID].tasks, ['t2']);
    });

    it('P4 migration: also ignores remove=true markers carrying projects', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { projects: ['p1', 'p2'] }));
      applyEvent(p, evt('session_unlink', TS_B, { projects: ['p1'] }));
      applyEvent(p, evt('session_link', TS_C, {
        remove: true,
        projects: ['p1', 'p2'],
      }));
      assert.deepEqual(p.sessions[SID].projects, ['p2']);
    });

    it('rebuildFromEvents replays a P4-era remove marker as a no-op', () => {
      // End-to-end rebuild over a sequence that mimics what a real P4 →
      // P5-rebuilt events.jsonl looks like.
      const events = [
        evt('session_link', TS_A, { tasks: ['t1', 't2', 't3'] }, 'a'),
        evt('session_link', TS_B, { remove: true, tasks: ['t1'] }, 'b'),
        evt('session_unlink', TS_C, { tasks: ['t1'] }, 'c'),
      ];
      const p = rebuildFromEvents(events);
      // If the reducer didn't honor the remove marker as a no-op, the rebuild
      // would yield ['t1','t2','t3'] (event B's add path) followed by event C
      // removing t1 → ['t2','t3'] — same final state by accident in this
      // contrived ordering. The discriminating case is the one BELOW where
      // the operator never re-issued unlink under P5: rebuild MUST NOT
      // resurrect t1 just because of a legacy marker.
      assert.deepEqual(p.sessions[SID].tasks, ['t2', 't3']);
    });

    it('rebuildFromEvents does NOT resurrect tasks left only by P4 marker (the discriminating case)', () => {
      // Operator had t1+t2; tried `link --remove --task t1` under P4; never
      // re-issued under P5. Without the migration guard, replay would land
      // on tasks=['t1','t2'] because the remove marker re-emitted via the
      // session_link add path. WITH the guard the marker no-ops, so the
      // operator's intended state ['t2'] is preserved on rebuild.
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t2'] }));   // ground truth: only t2 remains in v0.2 cache
      applyEvent(p, evt('session_link', TS_B, { remove: true, tasks: ['t1'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t2']);
    });

    it('regression: legitimate P5 add-path session_link still works (no remove flag)', () => {
      // Without `remove: true` the reducer must remain additive.
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1'] }));
      applyEvent(p, evt('session_link', TS_B, { tasks: ['t2'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1', 't2']);
    });

    it('treats payload.remove with a non-true value as a normal add', () => {
      // Defensive: only the literal `true` triggers the migration guard.
      // Any other value (false / null / 1 / "true" / {}) is a normal add
      // event — the guard is intentionally narrow to avoid swallowing
      // unrelated payload shapes.
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { remove: false, tasks: ['t1'] }));
      applyEvent(p, evt('session_link', TS_B, { remove: 1, tasks: ['t2'] }));
      applyEvent(p, evt('session_link', TS_C, { remove: 'true', tasks: ['t3'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1', 't2', 't3']);
    });
  });

  describe('alias_set reducer', () => {
    it('sets alias to a non-empty string', () => {
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'mainline' }));
      assert.equal(p.sessions[SID].alias, 'mainline');
    });

    it('null alias clears the alias', () => {
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'mainline' }));
      applyEvent(p, evt('alias_set', TS_B, { alias: null }));
      assert.equal(p.sessions[SID].alias, null);
    });

    it('missing payload.alias is a no-op', () => {
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'a' }));
      applyEvent(p, evt('alias_set', TS_B, {}));
      assert.equal(p.sessions[SID].alias, 'a');
    });
  });

  describe('parent_set reducer', () => {
    it('sets parent_session_id', () => {
      const p = emptyProjection();
      applyEvent(p, evt('parent_set', TS_A, { parent_session_id: SID_2 }));
      assert.equal(p.sessions[SID].parent_session_id, SID_2);
    });

    it('null parent_session_id clears the link', () => {
      const p = emptyProjection();
      applyEvent(p, evt('parent_set', TS_A, { parent_session_id: SID_2 }));
      applyEvent(p, evt('parent_set', TS_B, { parent_session_id: null }));
      assert.equal(p.sessions[SID].parent_session_id, null);
    });
  });

  describe('close reducer', () => {
    it('sets outcome + closed_at + closed_reason', () => {
      const p = emptyProjection();
      applyEvent(p, evt('close', TS_C, { outcome: 'done', closed_reason: 'merged in MR 42' }));
      const s = p.sessions[SID];
      assert.equal(s.outcome, 'done');
      assert.equal(s.closed_at, TS_C);
      assert.equal(s.closed_reason, 'merged in MR 42');
    });

    it('omitting outcome leaves prior outcome intact', () => {
      const p = emptyProjection();
      applyEvent(p, evt('close', TS_C, { outcome: 'done' }));
      applyEvent(p, evt('close', TS_D, { closed_reason: 'note' }));
      assert.equal(p.sessions[SID].outcome, 'done');
      assert.equal(p.sessions[SID].closed_reason, 'note');
      assert.equal(p.sessions[SID].closed_at, TS_D);
    });
  });

  describe('sweep reducer', () => {
    it('updates activity_state', () => {
      const p = emptyProjection();
      applyEvent(p, evt('sweep', TS_C, { activity_state: 'idle' }));
      assert.equal(p.sessions[SID].activity_state, 'idle');
    });

    it('uses effective_last_progress only if newer than last_progress_at', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_B, { claude_session_id: 'cs-1' }));
      // Older ts must NOT lower last_progress_at.
      applyEvent(p, evt('sweep', TS_C, {
        activity_state: 'idle',
        effective_last_progress: TS_A,
      }));
      assert.equal(p.sessions[SID].last_progress_at, TS_B);
      // Newer ts moves it forward.
      applyEvent(p, evt('sweep', TS_C, {
        activity_state: 'idle',
        effective_last_progress: TS_D,
      }));
      assert.equal(p.sessions[SID].last_progress_at, TS_D);
    });
  });

  describe('session_unlink reducer (P5)', () => {
    it('removes named tasks while preserving others', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1', 't2', 't3'] }));
      applyEvent(p, evt('session_unlink', TS_B, { tasks: ['t2'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1', 't3']);
    });

    it('removes named projects while preserving others', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { projects: ['p1', 'p2', 'p3'] }));
      applyEvent(p, evt('session_unlink', TS_B, { projects: ['p1', 'p3'] }));
      assert.deepEqual(p.sessions[SID].projects, ['p2']);
    });

    it('removes both tasks and projects in a single event', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, {
        tasks: ['t1', 't2'],
        projects: ['p1', 'p2'],
      }));
      applyEvent(p, evt('session_unlink', TS_B, {
        tasks: ['t1'],
        projects: ['p2'],
      }));
      assert.deepEqual(p.sessions[SID].tasks, ['t2']);
      assert.deepEqual(p.sessions[SID].projects, ['p1']);
    });

    it('removing a non-existent task is a no-op (idempotent)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1'] }));
      applyEvent(p, evt('session_unlink', TS_B, { tasks: ['t-nope'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1']);
    });

    it('applying the same unlink twice is idempotent', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1', 't2'] }));
      applyEvent(p, evt('session_unlink', TS_B, { tasks: ['t1'] }));
      applyEvent(p, evt('session_unlink', TS_C, { tasks: ['t1'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t2']);
    });

    it('dedups within a single unlink payload', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1', 't2'] }));
      applyEvent(p, evt('session_unlink', TS_B, { tasks: ['t1', 't1', 't1'] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t2']);
    });

    it('empty / missing payload arrays leave session unchanged', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1'], projects: ['p1'] }));
      applyEvent(p, evt('session_unlink', TS_B, {}));
      applyEvent(p, evt('session_unlink', TS_C, { tasks: [], projects: [] }));
      assert.deepEqual(p.sessions[SID].tasks, ['t1']);
      assert.deepEqual(p.sessions[SID].projects, ['p1']);
    });

    it('ignores non-string entries in the remove payload', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_link', TS_A, { tasks: ['t1', 't2'] }));
      applyEvent(p, evt('session_unlink', TS_B, {
        tasks: [null, 42, '', undefined, 't1'],
      }));
      assert.deepEqual(p.sessions[SID].tasks, ['t2']);
    });

    it('does not affect tasks of OTHER sessions', () => {
      const evtFor = (sid, op, ts, payload) => ({
        ts, event_id: `evt_${sid}-${op}-${ts}`, op, stable_id: sid, payload,
      });
      const p = emptyProjection();
      applyEvent(p, evtFor(SID, 'session_link', TS_A, { tasks: ['t1'] }));
      applyEvent(p, evtFor(SID_2, 'session_link', TS_A, { tasks: ['t1'] }));
      applyEvent(p, evtFor(SID, 'session_unlink', TS_B, { tasks: ['t1'] }));
      assert.deepEqual(p.sessions[SID].tasks, []);
      assert.deepEqual(p.sessions[SID_2].tasks, ['t1']);
    });
  });

  describe('manual_link reducer', () => {
    it('appends parent_candidate_ids deduped by parent_id', () => {
      const p = emptyProjection();
      applyEvent(p, evt('manual_link', TS_A, {
        parent_candidate_ids: [
          { parent_id: SID_2, source: 'cwd-window', confidence: 0.5 },
        ],
      }));
      // Same parent_id arrives again → must not duplicate.
      applyEvent(p, evt('manual_link', TS_B, {
        parent_candidate_ids: [
          { parent_id: SID_2, source: 'lineage', confidence: 0.9 },
          { parent_id: 'sess_01970000-0000-7000-8000-000000000003', source: 'cwd-window' },
        ],
      }));
      const cands = p.sessions[SID].parent_candidate_ids;
      assert.equal(cands.length, 2);
      assert.equal(cands[0].parent_id, SID_2);
      assert.equal(cands[0].source, 'cwd-window');
      assert.equal(cands[1].parent_id, 'sess_01970000-0000-7000-8000-000000000003');
    });
  });

  describe('rebuildFromEvents', () => {
    it('folds a sequence into a deterministic projection', () => {
      const events = [
        evt('session_seen', TS_A, {
          claude_session_id: 'cs-1',
          transcript_file: { path: '/t/a.jsonl', size: 100 },
          first_prompt_preview: 'hello',
          fingerprints: { first_human_prompt_v1: 'fp1' },
        }),
        evt('alias_set', TS_A, { alias: 'first' }),
        evt('session_link', TS_B, { tasks: ['t1'], projects: ['p1'] }),
        evt('session_seen', TS_B, { claude_session_id: 'cs-2' }),
        evt('parent_set', TS_C, { parent_session_id: SID_2 }),
        evt('close', TS_D, { outcome: 'done', closed_reason: 'shipped' }),
      ];
      const p = rebuildFromEvents(events);
      assert.equal(p._meta.event_count, events.length);
      assert.equal(p._meta.last_event_id, events.at(-1).event_id);
      const s = p.sessions[SID];
      assert.equal(s.alias, 'first');
      assert.deepEqual(s.claude_session_ids, ['cs-1', 'cs-2']);
      assert.deepEqual(s.tasks, ['t1']);
      assert.deepEqual(s.projects, ['p1']);
      assert.equal(s.parent_session_id, SID_2);
      assert.equal(s.outcome, 'done');
      assert.equal(s.closed_at, TS_D);
      assert.equal(s.closed_reason, 'shipped');
    });

    it('applying the same event sequence twice yields equivalent projections (idempotent)', () => {
      const events = [
        evt('session_seen', TS_A, {
          claude_session_id: 'cs-1',
          transcript_file: { path: '/t/a.jsonl' },
        }),
        evt('session_seen', TS_B, {
          claude_session_id: 'cs-1',                     // duplicate
          transcript_file: { path: '/t/a.jsonl' },        // duplicate
        }),
        evt('session_link', TS_B, { tasks: ['t1', 't1'] }), // dedup within payload
      ];
      const p1 = rebuildFromEvents(events);
      const p2 = rebuildFromEvents(events);
      // Whitelist comparison on session content (event_count differs only if
      // events array differs, so skip that detail by comparing sessions).
      assert.deepEqual(p1.sessions, p2.sessions);
      assert.deepEqual(
        p1.sessions[SID].claude_session_ids,
        ['cs-1'],
        'duplicate claude_session_id deduped',
      );
      assert.equal(p1.sessions[SID].transcript_files.length, 1);
      assert.deepEqual(p1.sessions[SID].tasks, ['t1']);
    });

    it('handles events for multiple stable_ids independently', () => {
      const evtFor = (sid, op, ts, payload) => ({
        ts,
        event_id: `evt_${sid}-${ts}`,
        op,
        stable_id: sid,
        payload: payload ?? {},
      });
      const events = [
        evtFor(SID, 'session_seen', TS_A, { claude_session_id: 'cs-A' }),
        evtFor(SID_2, 'session_seen', TS_A, { claude_session_id: 'cs-B' }),
        evtFor(SID, 'alias_set', TS_B, { alias: 'first' }),
        evtFor(SID_2, 'alias_set', TS_B, { alias: 'second' }),
      ];
      const p = rebuildFromEvents(events);
      assert.equal(Object.keys(p.sessions).length, 2);
      assert.equal(p.sessions[SID].alias, 'first');
      assert.equal(p.sessions[SID_2].alias, 'second');
    });
  });

  describe('_meta bookkeeping', () => {
    it('event_count tracks total applied events', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, { claude_session_id: 'cs-1' }));
      applyEvent(p, evt('alias_set', TS_B, { alias: 'a' }));
      assert.equal(p._meta.event_count, 2);
    });

    it('last_event_id reflects most recent event', () => {
      const p = emptyProjection();
      const e1 = evt('session_seen', TS_A, { claude_session_id: 'cs-1' }, '1');
      const e2 = evt('alias_set', TS_B, { alias: 'a' }, '2');
      applyEvent(p, e1);
      applyEvent(p, e2);
      assert.equal(p._meta.last_event_id, e2.event_id);
    });
  });

  describe('error handling', () => {
    it('throws on missing projection or event', () => {
      assert.throws(() => applyEvent(null, evt('alias_set', TS_A, {})), /projection missing/);
      assert.throws(
        () => applyEvent(emptyProjection(), null),
        /event missing/,
      );
    });

    it('throws if event has no stable_id', () => {
      assert.throws(
        () => applyEvent(emptyProjection(), { op: 'alias_set', payload: {} }),
        /stable_id required/,
      );
    });

    it('unknown op is tolerated (still bumps event_count)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('zzz_unknown', TS_A, {}));
      assert.equal(p._meta.event_count, 1);
      // Session was created (auto-create on first event), with defaults.
      assert.ok(p.sessions[SID]);
      assert.equal(p.sessions[SID].activity_state, 'active');
    });
  });
});
