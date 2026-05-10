import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeEffectiveLastProgress,
  computeSweepTransitions,
} from '../sweep.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';

// Anchor "now" in tests so the assertions are stable regardless of when
// the suite runs. NOW is 2026-05-09T12:00:00Z; ages are derived from this.
const NOW_ISO = '2026-05-09T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days) {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

function mkProjection(sessions, meta = {}) {
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  return {
    _meta: {
      schema_version: 2,
      fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
      updated: NOW_ISO,
      event_count: 0,
      last_event_id: null,
      ...meta,
    },
    sessions: byId,
  };
}

function mkSession(stableId, overrides = {}) {
  return {
    stable_id: stableId,
    activity_state: 'active',
    last_progress_at: isoDaysAgo(0),
    transcript_files: [],
    ...overrides,
  };
}

describe('sweep.mjs', () => {
  describe('computeEffectiveLastProgress', () => {
    it('returns last_progress_at when no transcript / hive_watcher signals', () => {
      const ts = isoDaysAgo(3);
      const s = mkSession(SID_A, { last_progress_at: ts });
      assert.equal(computeEffectiveLastProgress(s), ts);
    });

    it('returns the max across last_progress_at + transcript mtimes', () => {
      const lpa = isoDaysAgo(5);
      const tf1 = isoDaysAgo(7);
      const tf2 = isoDaysAgo(2);   // newest
      const s = mkSession(SID_A, {
        last_progress_at: lpa,
        transcript_files: [
          { path: '/t/a.jsonl', mtime: tf1 },
          { path: '/t/b.jsonl', mtime: tf2 },
        ],
      });
      assert.equal(computeEffectiveLastProgress(s), tf2);
    });

    it('honors hive_watcher_last_seen when present and newer', () => {
      const lpa = isoDaysAgo(10);
      const hw = isoDaysAgo(1);    // newest
      const s = mkSession(SID_A, {
        last_progress_at: lpa,
        hive_watcher_last_seen: hw,
      });
      assert.equal(computeEffectiveLastProgress(s), hw);
    });

    it('ignores transcript entries without mtime', () => {
      const lpa = isoDaysAgo(5);
      const s = mkSession(SID_A, {
        last_progress_at: lpa,
        transcript_files: [
          { path: '/t/a.jsonl' },
          { path: '/t/b.jsonl', mtime: null },
        ],
      });
      assert.equal(computeEffectiveLastProgress(s), lpa);
    });

    it('falls back to epoch ISO when no candidate is parseable', () => {
      const s = mkSession(SID_A, {
        last_progress_at: 'not-a-date',
        transcript_files: [{ path: '/t/a.jsonl', mtime: 'also-bad' }],
      });
      assert.equal(computeEffectiveLastProgress(s), new Date(0).toISOString());
    });

    it('handles missing session input gracefully', () => {
      assert.equal(computeEffectiveLastProgress(null), new Date(0).toISOString());
      assert.equal(computeEffectiveLastProgress(undefined), new Date(0).toISOString());
    });

    // ---- codex P5 round-1 fix: epoch comparison, not lex sort ---------------

    it('picks the truly-latest epoch across mixed timezone offsets', () => {
      // All three reference the SAME wall-clock instant 2026-05-09T03:00:00Z,
      // but expressed in three different offsets. A naive lex sort would put
      // "2026-05-09T05:00:00+02:00" (string starts with "...T05") above
      // "2026-05-09T03:00:00.000Z" (string starts with "...T03"), even though
      // they're identical instants. Then a slightly LATER instant
      // 2026-05-09T03:00:01Z encoded as -01:00 ("2026-05-09T02:00:01-01:00")
      // would lose the lex sort vs. the equal-instant +02:00 version.
      // Date.parse() resolves them all to epoch ms and the true max wins.
      const earlierInstantPlusTwo = '2026-05-09T05:00:00+02:00';   // 03:00:00 UTC
      const sameInstantUtc        = '2026-05-09T03:00:00.000Z';    // 03:00:00 UTC
      const laterInstantMinusOne  = '2026-05-09T02:00:01-01:00';   // 03:00:01 UTC (winner)
      const s = mkSession(SID_A, {
        last_progress_at: earlierInstantPlusTwo,
        transcript_files: [
          { path: '/t/a.jsonl', mtime: sameInstantUtc },
          { path: '/t/b.jsonl', mtime: laterInstantMinusOne },
        ],
      });
      const out = computeEffectiveLastProgress(s);
      // We normalize back to Z ISO; the instant is 03:00:01 UTC.
      assert.equal(Date.parse(out), Date.parse(laterInstantMinusOne));
      assert.equal(out, '2026-05-09T03:00:01.000Z');
    });

    it('picks the truly-latest epoch across mixed fractional precision', () => {
      // Lex compare on these is wrong: at position 19 onward we have
      //   "2026-05-09T10:00:00.500Z"  (string A)
      //   "2026-05-09T10:00:00Z"      (string B)
      // Lex puts A > B because '.' (0x2E) > 'Z' (0x5A) is FALSE — but A
      // (length 24) vs B (length 20) compare char-by-char and stop at the
      // shorter string's end, so JS sort picks A as larger ONLY because of
      // its longer length, not its semantic recency. That happens to be
      // right here. Now flip: A = ...100Z, B = ...100.500Z. Lex puts B > A
      // because '.' (after "100") < 'Z' is FALSE again — actually JS picks
      // the longer string per char. Coincidence covers some inputs and not
      // others. Date.parse normalizes everything.
      const lowPrecision  = '2026-05-09T10:00:00Z';        // 1746783600000 ms
      const midPrecision  = '2026-05-09T10:00:00.100Z';    // 1746783600100 ms
      const highPrecision = '2026-05-09T10:00:00.500500Z'; // 1746783600500 ms (winner)
      const s = mkSession(SID_A, {
        last_progress_at: lowPrecision,
        transcript_files: [{ path: '/t/a.jsonl', mtime: midPrecision }],
        hive_watcher_last_seen: highPrecision,
      });
      const out = computeEffectiveLastProgress(s);
      assert.equal(Date.parse(out), Date.parse(highPrecision));
    });

    it('skips unparseable candidates while honoring valid ones', () => {
      // A mix of garbage + a real ts → real ts wins.
      const realTs = '2026-05-09T11:00:00.000Z';
      const s = mkSession(SID_A, {
        last_progress_at: 'not-a-date',
        transcript_files: [
          { path: '/t/a.jsonl', mtime: '2026-13-99T99:99:99Z' },  // invalid
          { path: '/t/b.jsonl', mtime: realTs },
        ],
        hive_watcher_last_seen: '',
      });
      assert.equal(computeEffectiveLastProgress(s), realTs);
    });

    it('returns normalized Z ISO even when the winning input had an offset', () => {
      // Single non-Z input, no other signal. Output is the same instant in Z.
      const offsetTs = '2026-05-09T05:30:00+05:30';   // 00:00:00 UTC
      const s = mkSession(SID_A, {
        last_progress_at: offsetTs,
        transcript_files: [],
      });
      const out = computeEffectiveLastProgress(s);
      assert.equal(out, '2026-05-09T00:00:00.000Z');
      assert.equal(Date.parse(out), Date.parse(offsetTs));
    });
  });

  describe('computeSweepTransitions — basic state machine', () => {
    it('empty projection → empty transitions', () => {
      const p = mkProjection([]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.deepEqual(t, []);
    });

    it('active session under idle threshold → no transition', () => {
      // Default thresholds: idle=14, archive=30. Age 5 days < 14 → stay active.
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(5) }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.deepEqual(t, []);
    });

    it('active + age == idle threshold → transition to idle', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(14) }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.equal(t.length, 1);
      assert.equal(t[0].stable_id, SID_A);
      assert.equal(t[0].from_state, 'active');
      assert.equal(t[0].to_state, 'idle');
      assert.equal(t[0].age_days, 14);
    });

    it('active + age == archive threshold → transition to archived (skips idle)', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(30) }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.equal(t.length, 1);
      assert.equal(t[0].from_state, 'active');
      assert.equal(t[0].to_state, 'archived');
      assert.equal(t[0].age_days, 30);
    });

    it('idle + age >= archive threshold → transition to archived', () => {
      const p = mkProjection([
        mkSession(SID_A, {
          activity_state: 'idle',
          last_progress_at: isoDaysAgo(45),
        }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.equal(t.length, 1);
      assert.equal(t[0].from_state, 'idle');
      assert.equal(t[0].to_state, 'archived');
    });

    it('archived sessions are terminal — never re-promoted by sweep', () => {
      const p = mkProjection([
        mkSession(SID_A, {
          activity_state: 'archived',
          last_progress_at: isoDaysAgo(0),    // even with fresh activity
        }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.deepEqual(t, []);
    });

    it('multiple sessions in mixed states → only those needing transition', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(2) }),       // active stays
        mkSession(SID_B, { last_progress_at: isoDaysAgo(20) }),      // active → idle
        mkSession(SID_C, {
          activity_state: 'idle',
          last_progress_at: isoDaysAgo(40),
        }),                                                          // idle → archived
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      const byId = Object.fromEntries(t.map((x) => [x.stable_id, x]));
      assert.equal(t.length, 2);
      assert.equal(byId[SID_A], undefined);
      assert.equal(byId[SID_B].to_state, 'idle');
      assert.equal(byId[SID_C].to_state, 'archived');
    });
  });

  describe('computeSweepTransitions — boundary semantics', () => {
    it('age == idle threshold-1 stays active', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(13) }),
      ]);
      assert.deepEqual(computeSweepTransitions(p, { now: NOW_MS }), []);
    });

    it('age == archive threshold-1 transitions to idle (not archived)', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(29) }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.equal(t.length, 1);
      assert.equal(t[0].to_state, 'idle');
    });

    it('age == idle threshold exactly transitions (>= boundary)', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(14) }),
      ]);
      assert.equal(
        computeSweepTransitions(p, { now: NOW_MS })[0].to_state,
        'idle',
      );
    });

    it('age == archive threshold exactly transitions to archived (>= boundary)', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(30) }),
      ]);
      assert.equal(
        computeSweepTransitions(p, { now: NOW_MS })[0].to_state,
        'archived',
      );
    });

    it('idempotent: re-sweeping post-transition projection yields no new transitions', () => {
      // Simulate the projection AFTER a sweep already moved A to idle.
      const p = mkProjection([
        mkSession(SID_A, {
          activity_state: 'idle',
          last_progress_at: isoDaysAgo(20),     // still in idle window
        }),
      ]);
      assert.deepEqual(computeSweepTransitions(p, { now: NOW_MS }), []);
    });
  });

  describe('computeSweepTransitions — threshold sources', () => {
    it('opts.idleThresholdDays overrides _meta + default', () => {
      // _meta says 14 (default); opts overrides to 7. A session aged 8d
      // should now flip to idle.
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(8) }),
      ]);
      const t = computeSweepTransitions(p, {
        now: NOW_MS,
        idleThresholdDays: 7,
      });
      assert.equal(t.length, 1);
      assert.equal(t[0].to_state, 'idle');
    });

    it('opts.archiveThresholdDays overrides _meta + default', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(20) }),
      ]);
      // Archive lowered to 15 → 20d session jumps active → archived.
      const t = computeSweepTransitions(p, {
        now: NOW_MS,
        archiveThresholdDays: 15,
        idleThresholdDays: 7,
      });
      assert.equal(t[0].to_state, 'archived');
    });

    it('_meta thresholds picked up when opts not provided', () => {
      // _meta says idle=3, archive=10. Default would be 14/30 → no transition
      // for a 5-day-old session. With _meta 3, it transitions to idle.
      const p = mkProjection(
        [mkSession(SID_A, { last_progress_at: isoDaysAgo(5) })],
        { idle_threshold_days: 3, archive_threshold_days: 10 },
      );
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.equal(t.length, 1);
      assert.equal(t[0].to_state, 'idle');
    });

    it('falls back to defaults (14/30) when _meta + opts both absent', () => {
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(13) }),
        mkSession(SID_B, { last_progress_at: isoDaysAgo(14) }),
        mkSession(SID_C, { last_progress_at: isoDaysAgo(30) }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      // 13d → no transition. 14d → idle. 30d → archived.
      assert.equal(t.length, 2);
      const byId = Object.fromEntries(t.map((x) => [x.stable_id, x]));
      assert.equal(byId[SID_B].to_state, 'idle');
      assert.equal(byId[SID_C].to_state, 'archived');
    });

    it('rejects non-positive opts threshold and falls back', () => {
      // 0 / negative / NaN must NOT silently disable thresholds; we fall
      // back to _meta then default.
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: isoDaysAgo(15) }),
      ]);
      const t1 = computeSweepTransitions(p, {
        now: NOW_MS,
        idleThresholdDays: 0,             // ignored
      });
      assert.equal(t1.length, 1);
      assert.equal(t1[0].to_state, 'idle');  // default 14 kicks in (15 >= 14)
      const t2 = computeSweepTransitions(p, {
        now: NOW_MS,
        idleThresholdDays: -5,            // ignored
      });
      assert.equal(t2.length, 1);
    });
  });

  describe('computeSweepTransitions — effective_last_progress integration', () => {
    it('transcript mtime newer than last_progress_at keeps a session active', () => {
      // last_progress_at 20 days ago → would normally go idle. But transcript
      // mtime says we wrote yesterday → effective ts is 1d → still active.
      const p = mkProjection([
        mkSession(SID_A, {
          last_progress_at: isoDaysAgo(20),
          transcript_files: [{ path: '/t/a.jsonl', mtime: isoDaysAgo(1) }],
        }),
      ]);
      assert.deepEqual(computeSweepTransitions(p, { now: NOW_MS }), []);
    });

    it('records effective_last_progress on the transition object', () => {
      const lpa = isoDaysAgo(20);
      const p = mkProjection([
        mkSession(SID_A, { last_progress_at: lpa }),
      ]);
      const t = computeSweepTransitions(p, { now: NOW_MS });
      assert.equal(t[0].effective_last_progress, lpa);
    });

    it('hive_watcher_last_seen newer than transcripts wins', () => {
      const p = mkProjection([
        mkSession(SID_A, {
          last_progress_at: isoDaysAgo(30),
          transcript_files: [{ path: '/t/a.jsonl', mtime: isoDaysAgo(20) }],
          hive_watcher_last_seen: isoDaysAgo(2),
        }),
      ]);
      // Effective is 2d → active stays active.
      assert.deepEqual(computeSweepTransitions(p, { now: NOW_MS }), []);
    });
  });

  describe('computeSweepTransitions — defensive handling', () => {
    it('skips sessions with unparseable timestamps entirely', () => {
      const p = mkProjection([
        mkSession(SID_A, {
          last_progress_at: 'garbage',
          transcript_files: [{ path: '/t/a.jsonl', mtime: 'also-bad' }],
        }),
      ]);
      // Effective falls back to epoch (which would be > 30 days), but we
      // guard against treating "no signal at all" as infinitely old.
      assert.deepEqual(computeSweepTransitions(p, { now: NOW_MS }), []);
    });

    it('handles a missing sessions map', () => {
      assert.deepEqual(
        computeSweepTransitions({ _meta: {}, sessions: undefined }, { now: NOW_MS }),
        [],
      );
      assert.deepEqual(computeSweepTransitions({}, { now: NOW_MS }), []);
      assert.deepEqual(computeSweepTransitions(null, { now: NOW_MS }), []);
    });

    it('skips non-object session entries', () => {
      const p = mkProjection([]);
      p.sessions[SID_A] = null;
      p.sessions[SID_B] = 'not-a-session';
      assert.deepEqual(computeSweepTransitions(p, { now: NOW_MS }), []);
    });
  });
});
