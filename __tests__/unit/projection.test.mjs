import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  emptyProjection,
  emptySession,
  rebuildFromEvents,
} from '../../lib/projection.mjs';

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
      assert.equal(s.ai_title, null);
    });
  });

  describe('ai_title_seen reducer (0.1.6)', () => {
    it('sets ai_title from payload.ai_title (string)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('ai_title_seen', TS_A, {
        ai_title: 'refactor backend storage layer',
        source_transcript: '/tmp/x.jsonl',
        observed_at: TS_A,
      }));
      assert.equal(p.sessions[SID].ai_title, 'refactor backend storage layer');
    });

    it('last-write-wins across multiple ai_title_seen events', () => {
      const p = emptyProjection();
      applyEvent(p, evt('ai_title_seen', TS_A, { ai_title: 'first title' }));
      applyEvent(p, evt('ai_title_seen', TS_B, { ai_title: 'second title' }));
      applyEvent(p, evt('ai_title_seen', TS_C, { ai_title: 'third title' }));
      assert.equal(p.sessions[SID].ai_title, 'third title');
    });

    it('payload.ai_title = null clears the title', () => {
      const p = emptyProjection();
      applyEvent(p, evt('ai_title_seen', TS_A, { ai_title: 'a title' }));
      applyEvent(p, evt('ai_title_seen', TS_B, { ai_title: null }));
      assert.equal(p.sessions[SID].ai_title, null);
    });

    it('missing / empty / non-string payload.ai_title is a no-op (defensive)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('ai_title_seen', TS_A, { ai_title: 'baseline' }));
      applyEvent(p, evt('ai_title_seen', TS_B, {}));                    // missing
      applyEvent(p, evt('ai_title_seen', TS_C, { ai_title: '' }));      // empty
      applyEvent(p, evt('ai_title_seen', TS_D, { ai_title: 42 }));      // non-string
      assert.equal(p.sessions[SID].ai_title, 'baseline',
        'defensive: only string or explicit null should mutate ai_title');
    });

    it('does NOT overwrite alias (separate fields)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'user-set' }));
      applyEvent(p, evt('ai_title_seen', TS_B, { ai_title: 'ai-derived' }));
      assert.equal(p.sessions[SID].alias, 'user-set');
      assert.equal(p.sessions[SID].ai_title, 'ai-derived');
    });

    it('rebuildFromEvents replays ai_title_seen deterministically', () => {
      const events = [
        evt('session_seen', TS_A, { claude_session_id: 'cs-1' }),
        evt('ai_title_seen', TS_B, { ai_title: 'first' }),
        evt('ai_title_seen', TS_C, { ai_title: 'final' }),
      ];
      const p1 = rebuildFromEvents(events);
      const p2 = rebuildFromEvents(events);
      assert.equal(p1.sessions[SID].ai_title, 'final');
      assert.deepEqual(p1.sessions, p2.sessions);
    });

    it('defensive shim materializes ai_title=null on legacy sessions loaded without the field', () => {
      // Simulate a legacy projection state where the session record was
      // persisted before 0.1.6 (no ai_title key). Trigger any session_seen
      // event so the shim runs.
      const p = emptyProjection();
      p.sessions[SID] = emptySession(SID, TS_A);
      delete p.sessions[SID].ai_title;
      applyEvent(p, evt('session_seen', TS_B, { claude_session_id: 'cs-1' }));
      assert.equal(p.sessions[SID].ai_title, null,
        'session_seen reducer must backfill ai_title for legacy records');
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
      // Distinct id per event, including the two same-millisecond pairs.
      // `newEvent` mints a fresh UUIDv7 for every event, so two rows sharing
      // an `event_id` is not a shape the log can hold — and `event_count`
      // counts distinct events, so a fixture that reuses one is asserting
      // against a log that cannot exist.
      const events = [
        evt('session_seen', TS_A, {
          claude_session_id: 'cs-1',
          transcript_file: { path: '/t/a.jsonl', size: 100 },
          first_prompt_preview: 'hello',
          fingerprints: { first_human_prompt_v1: 'fp1' },
        }, '1'),
        evt('alias_set', TS_A, { alias: 'first' }, '2'),
        evt('session_link', TS_B, { tasks: ['t1'], projects: ['p1'] }, '3'),
        evt('session_seen', TS_B, { claude_session_id: 'cs-2' }, '4'),
        evt('parent_set', TS_C, { parent_session_id: SID_2 }, '5'),
        evt('close', TS_D, { outcome: 'done', closed_reason: 'shipped' }, '6'),
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

    it('re-folding the last event does not move event_count', () => {
      // The module header promises that applying the same event twice leaves
      // the projection unchanged. `_meta` is part of the projection, and an
      // unconditional `+= 1` broke that promise for the one field whose job is
      // to tell callers whether the projection has drifted from the log.
      const p = emptyProjection();
      const e1 = evt('session_seen', TS_A, { claude_session_id: 'cs-1' }, '1');
      applyEvent(p, e1);
      applyEvent(p, e1);
      applyEvent(p, e1);
      assert.equal(p._meta.event_count, 1, 'one event in the log, one counted');
      assert.equal(p._meta.last_event_id, e1.event_id);
    });

    it('two different events both count — the dedup is on identity, not effect', () => {
      // The boundary in the other direction. A second event that happens to
      // change nothing (same alias set twice) is still a line in the log, and
      // a counter that skipped it would report drift on a healthy projection.
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'same' }, '1'));
      applyEvent(p, evt('alias_set', TS_B, { alias: 'same' }, '2'));
      assert.equal(p._meta.event_count, 2);
      assert.equal(p.sessions[SID].names[0].set_count, 1, 'and the naming was still a no-op');
    });

    it('counts events that carry no event_id instead of collapsing them', () => {
      // `event_id` is optional in the reducer's tolerated input. Two events
      // without one are not "the same event" — they are two events nothing can
      // tell apart, so the safe reading is to count both. A naive
      // `event.event_id === _meta.last_event_id` test reads `undefined ===
      // null` as false on the first and would then compare `null === null` on
      // every one after it.
      const p = emptyProjection();
      applyEvent(p, { ts: TS_A, op: 'alias_set', stable_id: SID, payload: { alias: 'x' } });
      applyEvent(p, { ts: TS_B, op: 'alias_set', stable_id: SID, payload: { alias: 'y' } });
      assert.equal(p._meta.event_count, 2);
      assert.equal(p._meta.last_event_id, null);
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

  // -------------------------------------------------------------------------
  // session_progress — the per-turn heartbeat written by the UserPromptSubmit
  // hook. Its field semantics are deliberately asymmetric, and each half has
  // a defect it exists to fix.
  // -------------------------------------------------------------------------

  describe('reduceSessionProgress', () => {
    it('appends claude_session_id (deduped)', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_progress', TS_A, { claude_session_id: 'csid-1' }));
      applyEvent(p, evt('session_progress', TS_B, { claude_session_id: 'csid-1' }, 'b'));
      applyEvent(p, evt('session_progress', TS_C, { claude_session_id: 'csid-2' }, 'c'));
      assert.deepEqual(p.sessions[SID].claude_session_ids, ['csid-1', 'csid-2']);
    });

    it('advances last_progress_at on every event', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_progress', TS_A, { claude_session_id: 'csid-1' }));
      assert.equal(p.sessions[SID].last_progress_at, TS_A);
      applyEvent(p, evt('session_progress', TS_D, { claude_session_id: 'csid-1' }, 'd'));
      assert.equal(p.sessions[SID].last_progress_at, TS_D);
    });

    it('first_prompt_preview is FIRST-write-wins', () => {
      // Last-write-wins here would leave every session titled by whatever the
      // user typed most recently ("ok", "continue") instead of by the question
      // that opened it.
      const p = emptyProjection();
      applyEvent(p, evt('session_progress', TS_A, {
        claude_session_id: 'csid-1',
        first_prompt_preview: 'the original question',
      }));
      applyEvent(p, evt('session_progress', TS_B, {
        claude_session_id: 'csid-1',
        first_prompt_preview: 'ok',
      }, 'b'));
      assert.equal(p.sessions[SID].first_prompt_preview, 'the original question');
    });

    it('a null preview does not latch, so a later real preview still lands', () => {
      // The privacy opt-out sends null. If null latched, turning the opt-out
      // back off would never recover a preview for that session.
      const p = emptyProjection();
      applyEvent(p, evt('session_progress', TS_A, {
        claude_session_id: 'csid-1',
        first_prompt_preview: null,
      }));
      assert.equal(p.sessions[SID].first_prompt_preview, null);
      applyEvent(p, evt('session_progress', TS_B, {
        claude_session_id: 'csid-1',
        first_prompt_preview: 'now it is stored',
      }, 'b'));
      assert.equal(p.sessions[SID].first_prompt_preview, 'now it is stored');
    });

    it('branch_current / head_last_seen are LAST-write-wins', () => {
      // These are the only fields that genuinely drift mid-session, which is
      // the entire justification for the hook paying for a git probe.
      const p = emptyProjection();
      applyEvent(p, evt('session_progress', TS_A, {
        claude_session_id: 'csid-1',
        branch_current: 'master',
        head_last_seen: 'a'.repeat(40),
      }));
      applyEvent(p, evt('session_progress', TS_B, {
        claude_session_id: 'csid-1',
        branch_current: 'feat/x',
        head_last_seen: 'b'.repeat(40),
      }, 'b'));
      assert.equal(p.sessions[SID].branch_current, 'feat/x');
      assert.equal(p.sessions[SID].head_last_seen, 'b'.repeat(40));
    });

    it('does not touch branch_at_start / head_at_start', () => {
      // Progress events describe "now". Overwriting the at-start snapshot
      // would destroy the only record of where the session began.
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, {
        claude_session_id: 'csid-1',
        branch_at_start: 'master',
        head_at_start: 'a'.repeat(40),
      }));
      applyEvent(p, evt('session_progress', TS_B, {
        claude_session_id: 'csid-1',
        branch_current: 'feat/x',
        head_last_seen: 'b'.repeat(40),
      }, 'b'));
      assert.equal(p.sessions[SID].branch_at_start, 'master');
      assert.equal(p.sessions[SID].head_at_start, 'a'.repeat(40));
    });

    it('is idempotent under replay', () => {
      const events = [
        evt('session_progress', TS_A, { claude_session_id: 'csid-1', first_prompt_preview: 'q' }),
        evt('session_progress', TS_B, { claude_session_id: 'csid-1', branch_current: 'feat/x' }, 'b'),
      ];
      const once = rebuildFromEvents(events);
      const twice = rebuildFromEvents([...events, ...events]);
      assert.deepEqual(twice.sessions[SID].claude_session_ids,
        once.sessions[SID].claude_session_ids);
      assert.equal(twice.sessions[SID].first_prompt_preview,
        once.sessions[SID].first_prompt_preview);
      assert.equal(twice.sessions[SID].branch_current, once.sessions[SID].branch_current);
    });
  });

  // -------------------------------------------------------------------------
  // created_at — earliest-wins, so a promotion from the pending area can date
  // the record from process start rather than from the first prompt.
  // -------------------------------------------------------------------------

  describe('session_seen created_at (earliest-wins)', () => {
    it('an earlier payload created_at overrides the event ts', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_C, {
        claude_session_id: 'csid-1',
        created_at: TS_A,
      }));
      assert.equal(p.sessions[SID].created_at, TS_A);
      // last_progress_at still reflects the event, not the backdated birth.
      assert.equal(p.sessions[SID].last_progress_at, TS_C);
    });

    it('a LATER payload created_at is ignored', () => {
      // Monotone-decreasing is what makes the field order-independent; letting
      // a later value win would make replay order observable.
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, { claude_session_id: 'csid-1' }));
      applyEvent(p, evt('session_seen', TS_B, {
        claude_session_id: 'csid-1',
        created_at: TS_D,
      }, 'b'));
      assert.equal(p.sessions[SID].created_at, TS_A);
    });

    it('absent payload created_at leaves the event-ts default intact', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_B, { claude_session_id: 'csid-1' }));
      assert.equal(p.sessions[SID].created_at, TS_B);
    });
  });

  // -------------------------------------------------------------------------
  // session_prune — tombstone. The event log is append-only, so "delete" is a
  // reducer behaviour, not a log rewrite.
  // -------------------------------------------------------------------------

  describe('reduceSessionPrune (tombstone)', () => {
    it('removes the record from the projection', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, { claude_session_id: 'csid-1' }));
      assert.ok(p.sessions[SID]);
      applyEvent(p, evt('session_prune', TS_B, { reason: 'ghost' }, 'b'));
      assert.equal(p.sessions[SID], undefined);
    });

    it('still accounts for the event in _meta', () => {
      // Consumers use event_count to detect projection drift; a tombstone that
      // did not count would make a healthy projection look stale.
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, { claude_session_id: 'csid-1' }));
      applyEvent(p, evt('session_prune', TS_B, {}, 'b'));
      assert.equal(p._meta.event_count, 2);
      assert.equal(p._meta.last_event_id, `evt_test-${TS_B}-b`);
    });

    it('replay reproduces the pruned state exactly', () => {
      // This is the property that lets `rebuild` be safe after a prune: the
      // record must stay gone when the whole log is folded again.
      const events = [
        evt('session_seen', TS_A, { claude_session_id: 'csid-1' }),
        { ...evt('session_seen', TS_A, { claude_session_id: 'csid-2' }, 'keep'), stable_id: SID_2 },
        evt('session_prune', TS_B, { reason: 'ghost' }, 'b'),
      ];
      const rebuilt = rebuildFromEvents(events);
      assert.equal(rebuilt.sessions[SID], undefined, 'pruned record must stay gone');
      assert.ok(rebuilt.sessions[SID_2], 'other records must be untouched');
      // Folding twice is stable too.
      const twice = rebuildFromEvents([...events, ...events]);
      assert.equal(twice.sessions[SID], undefined);
      assert.ok(twice.sessions[SID_2]);
    });

    it('is idempotent — pruning an absent record does not throw', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_prune', TS_A, {}));
      applyEvent(p, evt('session_prune', TS_B, {}, 'b'));
      assert.equal(p.sessions[SID], undefined);
      assert.equal(p._meta.event_count, 2);
    });

    it('a later event for a pruned stable_id rebuilds it from scratch', () => {
      // Deliberate semantics: the tombstone says "garbage as of this point in
      // the log". Real activity afterwards is real, and must not be silently
      // discarded by a stale tombstone.
      const p = emptyProjection();
      applyEvent(p, evt('session_seen', TS_A, {
        claude_session_id: 'csid-1',
        first_prompt_preview: 'old',
      }));
      applyEvent(p, evt('session_prune', TS_B, {}, 'b'));
      applyEvent(p, evt('session_seen', TS_C, {
        claude_session_id: 'csid-2',
        first_prompt_preview: 'new',
      }, 'c'));
      assert.ok(p.sessions[SID], 'post-tombstone activity resurrects the record');
      assert.deepEqual(p.sessions[SID].claude_session_ids, ['csid-2'],
        'the resurrected record starts clean — no pre-tombstone state leaks back');
      assert.equal(p.sessions[SID].first_prompt_preview, 'new');
      assert.equal(p.sessions[SID].created_at, TS_C);
    });

    // -----------------------------------------------------------------------
    // Version skew — a documented hazard, pinned so the documentation cannot
    // quietly stop being true.
    //
    // The README used to claim that an older reader treats every new 0.2.0 op
    // as a no-op. That is right for `session_progress` and WRONG for
    // `session_prune`: `applyEvent` eagerly creates the session record before
    // dispatching on the op, and only 0.2.0+ knows to delete it again. An
    // older reducer therefore RESURRECTS every pruned record — dated to the
    // tombstone's ts, so it also looks more recently active than it ever was
    // — and `rebuild` persists that. Nothing detects it: `schema_version`
    // stays 2 and no shipped reader compares it anyway.
    //
    // The stand-in below is `applyEvent` minus the two lines that make
    // tombstones work, which is exactly what a pre-0.2.0 reducer is. If a
    // future change makes tombstones survive an old reader, this test fails
    // and the README's "Version skew" section needs rewriting with it.
    // -----------------------------------------------------------------------
    it('an old reducer (no prune case) resurrects the record — README "Version skew"', () => {
      const preTombstoneApply = (projection, event) => {
        const { op, stable_id: stableId, ts } = event;
        let session = projection.sessions[stableId];
        if (!session) {
          session = emptySession(stableId, ts);
          projection.sessions[stableId] = session;
        }
        if (op === 'session_seen') {
          const p = event.payload ?? {};
          if (p.claude_session_id) session.claude_session_ids.push(p.claude_session_id);
          if (p.first_prompt_preview) session.first_prompt_preview = p.first_prompt_preview;
        }
        // No `case 'session_prune'`, and no `op !== 'session_prune'` guard —
        // an unknown op falls through to the activity bump.
        if (op !== 'sweep' && ts && (!session.last_progress_at || ts > session.last_progress_at)) {
          session.last_progress_at = ts;
        }
        projection._meta.event_count += 1;
        return projection;
      };

      const events = [
        evt('session_seen', TS_A, { claude_session_id: 'csid-1', first_prompt_preview: 'real' }),
        evt('session_prune', TS_D, { reason: 'ghost' }, 'b'),
      ];

      const current = rebuildFromEvents(events);
      assert.equal(current.sessions[SID], undefined, 'the current reducer honours the tombstone');

      const old = emptyProjection();
      for (const e of events) preTombstoneApply(old, e);
      assert.ok(old.sessions[SID], 'an old reducer brings the pruned record back');
      assert.equal(old.sessions[SID].last_progress_at, TS_D,
        'and dates it from the tombstone, i.e. more recent than it ever really was');
    });

    // -----------------------------------------------------------------------
    // Version skew — third member of the family, added with `pr_link_seen`
    // (0.4.0). Same rule as the two above: a new op must be documented under
    // "Version skew" in the README and pinned here, or the documentation
    // quietly stops being true.
    //
    // This one is NOT destructive to `events.jsonl` — every row survives and a
    // newer `rebuild` restores the links. What makes it worth pinning is the
    // entry point the README already names for `name_set`: `loadProjection`
    // rebuilds whenever the cache is missing or corrupt, so an older binary on
    // the same machine drops `pr_links` *without anybody asking it to
    // rebuild*, and the newer binary then reads that cache and believes it.
    //
    // Measured 2026-09-07 against the published 0.3.0: 0.4.0 writes
    // `pr_links = [#722]` → cache removed → one ordinary 0.3.0 heartbeat →
    // `pr_links` is gone → 0.4.0 reads the hot cache and still sees nothing →
    // an explicit 0.4.0 `rebuild` brings it back.
    // -----------------------------------------------------------------------
    // Same family, added with `codex_session_seen` (0.5.0). This one is worse
    // than the pr_links case: an unknown op still CREATES the record, so an
    // old reader turns every codex session into a fieldless husk that `prune`
    // would classify as a ghost.
    it('an old reducer (no codex_session_seen case) leaves a blank husk — README "Version skew"', () => {
      const preCodexApply = (projection, event) => {
        const { op, stable_id: stableId, ts } = event;
        let session = projection.sessions[stableId];
        if (!session) {
          session = emptySession(stableId, ts);
          projection.sessions[stableId] = session;
        }
        // No `case 'codex_session_seen'` — the record is created and then
        // nothing fills it in.
        projection._meta.event_count += 1;
        return projection;
      };

      const events = [evt('codex_session_seen', TS_A, {
        codex_session_id: '01a07d1a-4180-7ab3-be8c-336dc7f2bab3',
        cwd: '/tmp/ws',
        first_prompt_preview: 'the prompt that goes missing',
      })];

      const current = rebuildFromEvents(events);
      assert.equal(current.sessions[SID].source, 'codex',
        'control: the current reducer does fill the record');
      assert.equal(current.sessions[SID].first_prompt_preview, 'the prompt that goes missing');

      const old = emptyProjection();
      for (const e of events) preCodexApply(old, e);
      assert.ok(old.sessions[SID], 'the record exists — an unknown op still creates it');
      assert.equal(old.sessions[SID].source, 'claude', 'and it claims to be a Claude session');
      assert.equal(old.sessions[SID].first_prompt_preview, null,
        'with nothing in it — this is the husk `prune` would call a ghost');
      assert.equal(old._meta.event_count, 1, 'while still counting the event');
    });

    it('an old reducer (no pr_link_seen case) drops pr_links — README "Version skew"', () => {
      // `applyEvent` minus the one case, which is exactly what 0.3.0 is.
      const prePrLinkApply = (projection, event) => {
        const { op, stable_id: stableId, ts } = event;
        let session = projection.sessions[stableId];
        if (!session) {
          session = emptySession(stableId, ts);
          projection.sessions[stableId] = session;
        }
        if (op === 'session_seen') {
          const p = event.payload ?? {};
          if (p.claude_session_id) session.claude_session_ids.push(p.claude_session_id);
        }
        // No `case 'pr_link_seen'` — an unknown op is a no-op for the record.
        projection._meta.event_count += 1;
        return projection;
      };

      const events = [
        evt('session_seen', TS_A, { claude_session_id: 'csid-1' }),
        evt('pr_link_seen', TS_B, {
          repository: 'druumen/cn/drummen',
          number: 722,
          url: 'https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/722',
        }, 'b'),
      ];

      const current = rebuildFromEvents(events);
      assert.deepEqual(current.sessions[SID].pr_links.map((l) => l.number), [722],
        'control: the current reducer does fold the link, so the loss below is the OLD reducer');

      const old = emptyProjection();
      for (const e of events) prePrLinkApply(old, e);
      assert.deepEqual(old.sessions[SID].pr_links, [],
        'an old reducer rebuilding the cache leaves the links out of the projection');
      assert.equal(old._meta.event_count, 2,
        'while still counting the event, so nothing downstream notices the gap');
    });
  });
});
