import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PARENT_CANDIDATES,
  STRONG_CORROBORATORS,
  WEAK_CORROBORATORS,
  capParentCandidates,
  classifyCorroborators,
  collectParentCandidates,
  findByClaudeSessionId,
  findByTranscriptLineage,
  meetsThreshold,
  resolveIdentity,
  scanFingerprintCandidates,
} from '../identity.mjs';
import { applyEvent, emptyProjection, emptySession } from '../projection.mjs';

const SID_A = 'sess_01970000-0000-7000-8000-00000000000a';
const SID_B = 'sess_01970000-0000-7000-8000-00000000000b';
const SID_C = 'sess_01970000-0000-7000-8000-00000000000c';
const SID_MINTED = 'sess_01970000-0000-7000-8000-000000aaaaaa';

const CSID_1 = '11111111-1111-1111-1111-111111111111';
const CSID_2 = '22222222-2222-2222-2222-222222222222';
const CSID_NEW = '33333333-3333-3333-3333-333333333333';

const FP_HUMAN_X = 'aaaaaaaaaaaaaaaa';
const FP_HUMAN_Y = 'bbbbbbbbbbbbbbbb';
const FP_LINEAGE_X = 'cccccccccccccccc';

const NOW_ISO = '2026-05-09T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

/**
 * Helper: build a projection with a session pre-populated. Pass field
 * overrides to set arbitrary attributes on the seeded session.
 */
function projectionWith(stableId, overrides = {}) {
  const p = emptyProjection();
  const s = emptySession(stableId, NOW_ISO);
  Object.assign(s, overrides);
  p.sessions[stableId] = s;
  return p;
}

function mintFn() {
  return SID_MINTED;
}

describe('identity.mjs', () => {
  describe('findByClaudeSessionId (P1 helper)', () => {
    it('returns the matching stable_id when claude_session_id is present', () => {
      const p = projectionWith(SID_A, { claude_session_ids: [CSID_1] });
      assert.equal(findByClaudeSessionId(p, CSID_1), SID_A);
    });

    it('returns null when no session has the csid', () => {
      const p = projectionWith(SID_A, { claude_session_ids: [CSID_1] });
      assert.equal(findByClaudeSessionId(p, CSID_NEW), null);
    });

    it('skips sessions with empty claude_session_ids[] (regression for P2 patch)', () => {
      const p = projectionWith(SID_A, { claude_session_ids: [] });
      assert.equal(findByClaudeSessionId(p, CSID_1), null);
    });
  });

  describe('findByTranscriptLineage (P2 helper)', () => {
    it('matches firstParentUuid against existing session.transcript_files[*].last_uuid', () => {
      const p = projectionWith(SID_A, {
        transcript_files: [
          { path: '/t/a.jsonl', last_uuid: 'uuid-tail' },
        ],
      });
      const hit = findByTranscriptLineage(p, { firstParentUuid: 'uuid-tail' });
      assert.ok(hit);
      assert.equal(hit.stableId, SID_A);
      assert.equal(hit.matchedPath, '/t/a.jsonl');
      assert.equal(hit.matchedLastUuid, 'uuid-tail');
    });

    it('returns null when transcriptMeta is null', () => {
      const p = projectionWith(SID_A, {
        transcript_files: [{ path: '/t/a.jsonl', last_uuid: 'uuid-tail' }],
      });
      assert.equal(findByTranscriptLineage(p, null), null);
    });

    it('returns null when firstParentUuid is null (fresh session)', () => {
      const p = projectionWith(SID_A, {
        transcript_files: [{ path: '/t/a.jsonl', last_uuid: 'uuid-tail' }],
      });
      assert.equal(findByTranscriptLineage(p, { firstParentUuid: null }), null);
    });

    it('returns null when no session has the matching last_uuid', () => {
      const p = projectionWith(SID_A, {
        transcript_files: [{ path: '/t/a.jsonl', last_uuid: 'uuid-other' }],
      });
      assert.equal(findByTranscriptLineage(p, { firstParentUuid: 'uuid-tail' }), null);
    });
  });

  describe('scanFingerprintCandidates (P3 helper)', () => {
    it('matches first_human_prompt_v1 + counts corroborators (cwd/branch/window)', () => {
      const p = projectionWith(SID_A, {
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        worktree_realpath: '/work/foo',
        branch_at_start: 'main',
        last_progress_at: NOW_ISO,
      });
      const rows = scanFingerprintCandidates(
        p,
        { first_human_prompt_v1: FP_HUMAN_X },
        {
          cwd: '/work/foo',
          worktreeRealpath: '/work/foo',
          branch: 'main',
          now: NOW_MS,
          timeWindowHours: 72,
        },
      );
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].fingerprintsMatched, ['first_human_prompt_v1']);
      assert.equal(rows[0].corroboratorCount, 4);
    });

    it('returns 0 corroborators when context is null AND last_progress is well outside window', () => {
      // Tests the gitContext=null + cwd=null fall-through. Stale
      // last_progress_at also keeps within_time_window=false.
      const p = projectionWith(SID_A, {
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        last_progress_at: '2026-01-01T00:00:00.000Z',
      });
      const rows = scanFingerprintCandidates(
        p,
        { first_human_prompt_v1: FP_HUMAN_X },
        { cwd: null, worktreeRealpath: null, branch: null, now: NOW_MS, timeWindowHours: 72 },
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].corroboratorCount, 0);
    });
  });

  describe('resolveIdentity — Priority 1 (claude_session_id_index)', () => {
    it('exact match returns confidence=exact', () => {
      const p = projectionWith(SID_A, { claude_session_ids: [CSID_1] });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_1,
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_A);
      assert.equal(r.source, 'claude_session_id_index');
      assert.equal(r.confidence, 'exact');
      assert.deepEqual(r.parentCandidates, []);
    });

    it('P1 hit short-circuits — does NOT consult P2 lineage even when lineage would also match', () => {
      // P1 candidate is SID_A (exact csid match). P2 candidate would be SID_B
      // (its transcript ends at the firstParentUuid). resolveIdentity must
      // pick SID_A, never look at SID_B.
      const p = emptyProjection();
      const sA = emptySession(SID_A, NOW_ISO);
      sA.claude_session_ids = [CSID_1];
      p.sessions[SID_A] = sA;

      const sB = emptySession(SID_B, NOW_ISO);
      sB.transcript_files = [{ path: '/t/b.jsonl', last_uuid: 'tail-uuid' }];
      p.sessions[SID_B] = sB;

      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_1,
        transcriptMeta: { firstParentUuid: 'tail-uuid' },
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_A, 'P1 must win over P2');
      assert.equal(r.source, 'claude_session_id_index');
    });
  });

  describe('resolveIdentity — Priority 2 (transcript_lineage)', () => {
    it('firstParentUuid → lastUuid match returns confidence=high', () => {
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        transcript_files: [{ path: '/t/a.jsonl', last_uuid: 'tail-1' }],
      });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW, // different csid — P1 misses
        transcriptMeta: { firstParentUuid: 'tail-1' },
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_A);
      assert.equal(r.source, 'transcript_lineage');
      assert.equal(r.confidence, 'high');
      assert.equal(r.matched.matched_last_uuid, 'tail-1');
    });

    it('skipped when transcriptMeta is null', () => {
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        transcript_files: [{ path: '/t/a.jsonl', last_uuid: 'tail-1' }],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
      });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        // No fingerprints either → must mint.
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_MINTED);
      assert.equal(r.source, 'minted');
    });
  });

  describe('resolveIdentity — Priority 3 (fingerprint + corroborator)', () => {
    function p3Projection() {
      // Existing session with fingerprints + sufficient context to corroborate.
      return projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        worktree_realpath: '/work/foo',
        branch_at_start: 'main',
        last_progress_at: NOW_ISO,
      });
    }

    it('fingerprint + 2 corroborators is accepted (low confidence)', () => {
      const r = resolveIdentity({
        projection: p3Projection(),
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_A);
      assert.equal(r.source, 'fingerprint_corroborator');
      assert.equal(r.confidence, 'low');
      assert.ok(r.matched.corroborator_count >= 2);
      assert.deepEqual(r.parentCandidates, []);
    });

    it('fingerprint + only 1 corroborator is rejected — minted + parent candidate surfaced', () => {
      const r = resolveIdentity({
        projection: p3Projection(),
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        // Only `same_cwd` corroborator — no git context, well past time window.
        gitContext: null,
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        // Move now well past the 72h window so within_time_window=false.
        now: NOW_MS + 200 * 3600 * 1000,
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_MINTED);
      assert.equal(r.source, 'minted');
      assert.equal(r.parentCandidates.length, 1);
      assert.equal(r.parentCandidates[0].stable_id, SID_A);
      assert.equal(r.parentCandidates[0].source, 'fingerprint');
      assert.equal(r.parentCandidates[0].reason.corroborator_count, 1);
    });

    it('time window edge — exactly 72h is within, 72h + 1ms is outside', () => {
      const baseLast = '2026-05-09T00:00:00.000Z';
      const baseLastMs = Date.parse(baseLast);
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        worktree_realpath: '/work/foo',
        branch_at_start: 'main',
        last_progress_at: baseLast,
      });

      // At-the-edge: now = base + 72h => within window (3 corroborators incl. window).
      const within = scanFingerprintCandidates(
        p,
        { first_human_prompt_v1: FP_HUMAN_X },
        {
          cwd: '/work/foo',
          worktreeRealpath: '/work/foo',
          branch: 'main',
          now: baseLastMs + 72 * 3600 * 1000,
          timeWindowHours: 72,
        },
      );
      assert.equal(within[0].corroborators.within_time_window, true);

      // 1 ms past the edge => outside.
      const outside = scanFingerprintCandidates(
        p,
        { first_human_prompt_v1: FP_HUMAN_X },
        {
          cwd: '/work/foo',
          worktreeRealpath: '/work/foo',
          branch: 'main',
          now: baseLastMs + 72 * 3600 * 1000 + 1,
          timeWindowHours: 72,
        },
      );
      assert.equal(outside[0].corroborators.within_time_window, false);
    });

    it('partial fingerprint match — only first_human_prompt_v1 hits — still corroborates', () => {
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        worktree_realpath: '/work/foo',
        branch_at_start: 'main',
        last_progress_at: NOW_ISO,
      });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        // Only the first_human_prompt_v1 fingerprint — lineage_prefix_v1 null.
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'fingerprint_corroborator');
      assert.deepEqual(r.matched.fingerprints_matched, ['first_human_prompt_v1']);
    });

    it('parentCandidates dedup — same stable_id matches both fingerprints, only one entry', () => {
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: FP_LINEAGE_X },
        // No corroborator-supporting context: cwd/branch/realpath/last all stale.
        cwd: '/totally/different',
        worktree_realpath: '/totally/different',
        branch_at_start: 'unrelated',
        last_progress_at: '2026-01-01T00:00:00.000Z',
      });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: FP_LINEAGE_X },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'minted');
      assert.equal(r.parentCandidates.length, 1, 'same stable_id must dedup');
      assert.equal(r.parentCandidates[0].stable_id, SID_A);
      assert.deepEqual(
        r.parentCandidates[0].reason.fingerprints_matched.sort(),
        ['first_human_prompt_v1', 'lineage_prefix_v1'].sort(),
      );
    });
  });

  describe('resolveIdentity — minted fallback', () => {
    it('empty projection → mints fresh stable_id', () => {
      const p = emptyProjection();
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: { firstParentUuid: null },
        gitContext: { worktreeRealpath: '/x', branch: 'main' },
        cwd: '/x',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.stableId, SID_MINTED);
      assert.equal(r.source, 'minted');
      assert.equal(r.confidence, 'minted');
      assert.deepEqual(r.matched, {});
      assert.deepEqual(r.parentCandidates, []);
    });

    it('hot loop — mint then second call with same csid hits P1 (regression for storage caller pattern)', () => {
      // Scenario: hook fires for the first time → mint A.
      // Then we add session A to the projection (mock what reduceSessionSeen
      // would do under the lock) and fire again with the same csid → P1 hit.
      const p = emptyProjection();
      const r1 = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: null,
        cwd: '/x',
        fingerprints: null,
        mintStableId: mintFn,
      });
      assert.equal(r1.source, 'minted');
      // Plant the minted session for the second call.
      const seeded = emptySession(r1.stableId, NOW_ISO);
      seeded.claude_session_ids = [CSID_NEW];
      p.sessions[r1.stableId] = seeded;
      const r2 = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: null,
        cwd: '/x',
        fingerprints: null,
        mintStableId: () => 'sess_should-not-be-used',
      });
      assert.equal(r2.stableId, r1.stableId);
      assert.equal(r2.source, 'claude_session_id_index');
    });
  });

  // ---------------------------------------------------------------------------
  // P3 round-1 codex review patches: strong corroborator gate, ambiguity,
  // candidate cap. The pre-patch P3 was too eager to accept fingerprint
  // matches (any 2 corroborators incl. weak signals like same-branch +
  // within-window) and silently picked the first projection-iteration entry
  // when several candidates met threshold.
  // ---------------------------------------------------------------------------
  describe('strong corroborator gate (P3 patch 1)', () => {
    function p3WeakOnly() {
      // Weak signals only on the seed: same_branch + last_progress in window.
      // No same_cwd / same_worktree_realpath because the seed lives at
      // /seed/path and the hook payload reports /work/foo.
      return projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/seed/path',
        worktree_realpath: '/seed/path',
        branch_at_start: 'main',
        last_progress_at: NOW_ISO,
      });
    }

    it('classifyCorroborators splits strong (cwd/realpath) vs weak (branch/window)', () => {
      const c = classifyCorroborators({
        same_cwd: true,
        same_worktree_realpath: false,
        same_branch_at_start: true,
        within_time_window: true,
      });
      assert.deepEqual(c, { strong: 1, weak: 2, total: 3 });
      // Sanity: the exported categories cover exactly the 4 corroborator keys.
      assert.deepEqual(
        [...STRONG_CORROBORATORS, ...WEAK_CORROBORATORS].sort(),
        ['same_branch_at_start', 'same_cwd', 'same_worktree_realpath', 'within_time_window'],
      );
    });

    it('meetsThreshold requires strong>=1 AND total>=min', () => {
      // Both required: failing either fails the gate.
      assert.equal(meetsThreshold({ strong: 0, weak: 4, total: 4 }), false,
        'weak-only signals must NOT pass even when total is huge');
      assert.equal(meetsThreshold({ strong: 1, weak: 0, total: 1 }), false,
        'strong=1 alone with total<min must fail');
      assert.equal(meetsThreshold({ strong: 1, weak: 1, total: 2 }), true,
        'strong>=1 + total>=2 is the canonical accept');
      assert.equal(meetsThreshold({ strong: 2, weak: 0, total: 2 }), true,
        'two strong signals (cwd + realpath) is enough on its own');
      // Min override.
      assert.equal(meetsThreshold({ strong: 1, weak: 1, total: 2 }, { minCorroborators: 3 }), false);
      assert.equal(meetsThreshold({ strong: 1, weak: 2, total: 3 }, { minCorroborators: 3 }), true);
    });

    it('REGRESSION: weak-only (same_branch + within_time_window) is REJECTED + surfaced as candidate', () => {
      // This is the codex-flagged false-merge: two unrelated sessions on
      // `main` within 72h would previously have weak=2 and be silently
      // accepted as the same identity. Patch: strong=0 → reject + mint.
      const r = resolveIdentity({
        projection: p3WeakOnly(),
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'minted', 'weak-only corroborators must NOT auto-merge');
      assert.equal(r.stableId, SID_MINTED);
      assert.equal(r.parentCandidates.length, 1, 'rejected match still surfaces as candidate');
      assert.equal(r.parentCandidates[0].stable_id, SID_A);
      assert.equal(r.parentCandidates[0].reason.strong_corroborator_count, 0);
      assert.equal(r.parentCandidates[0].reason.corroborator_count, 2);
    });

    it('one strong (same_cwd) + one weak (within_window) = accept', () => {
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        worktree_realpath: '/different/realpath', // strong miss
        branch_at_start: 'feature-y', // weak miss
        last_progress_at: NOW_ISO,
      });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'fingerprint_corroborator');
      assert.equal(r.stableId, SID_A);
      assert.equal(r.matched.strong_corroborator_count, 1);
    });

    it('two strong only (cwd + worktree_realpath, no weak) = accept (no need for weak)', () => {
      const p = projectionWith(SID_A, {
        claude_session_ids: [CSID_1],
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        cwd: '/work/foo',
        worktree_realpath: '/work/foo',
        branch_at_start: 'unrelated-branch', // weak miss
        // last_progress well outside 72h window so within_time_window=false.
        last_progress_at: '2025-01-01T00:00:00.000Z',
      });
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'fingerprint_corroborator');
      assert.equal(r.matched.strong_corroborator_count, 2);
      assert.equal(r.matched.corroborator_count, 2);
    });
  });

  describe('ambiguous P3 match (P3 patch 2)', () => {
    it('two candidates above threshold → MINT + surface BOTH as parent_candidates', () => {
      // Both seed sessions share the same fingerprint AND both individually
      // pass the strong-corroborator gate against the incoming hook signals.
      // Pre-patch: silently picks first projection-iteration entry → could
      // false-merge into the wrong one. Patch: refuse to pick, mint + surface.
      const p = emptyProjection();
      // Seed A — same_cwd + same_worktree_realpath (strong=2).
      const sA = emptySession(SID_A, NOW_ISO);
      sA.claude_session_ids = [CSID_1];
      sA.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
      sA.cwd = '/work/foo';
      sA.worktree_realpath = '/work/foo';
      sA.branch_at_start = 'main';
      sA.last_progress_at = NOW_ISO;
      p.sessions[SID_A] = sA;
      // Seed B — same_cwd + same_worktree_realpath ALSO strong=2 (e.g. same
      // workspace, different prior session that left the same fingerprint).
      const sB = emptySession(SID_B, NOW_ISO);
      sB.claude_session_ids = [CSID_2];
      sB.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
      sB.cwd = '/work/foo';
      sB.worktree_realpath = '/work/foo';
      sB.branch_at_start = 'main';
      sB.last_progress_at = NOW_ISO;
      p.sessions[SID_B] = sB;

      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'minted', 'ambiguous match must mint, not pick');
      assert.equal(r.stableId, SID_MINTED);
      assert.equal(r.matched.ambiguous, true);
      assert.equal(r.matched.ambiguous_count, 2);
      assert.equal(r.parentCandidates.length, 2,
        'both ambiguous candidates surface so caller can disambiguate');
      const ids = r.parentCandidates.map((c) => c.stable_id).sort();
      assert.deepEqual(ids, [SID_A, SID_B].sort());
    });
  });

  describe('parent candidate cap (P3 patch 3)', () => {
    it('synthesizes 20 fingerprint matches → only top 16 surface, omitted=4', () => {
      // Build 20 below-threshold fingerprint matches (no strong corroborators
      // → all rejected, all surface as parent_candidates). Cap=16 → 4 omitted.
      const p = emptyProjection();
      const ids = [];
      for (let i = 0; i < 20; i++) {
        const sid = `sess_01970000-0000-7000-8000-0000000000${i.toString(16).padStart(2, '0')}`;
        ids.push(sid);
        const s = emptySession(sid, NOW_ISO);
        s.claude_session_ids = [`csid-${i}`];
        s.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
        // Distinct cwds so NONE qualify as strong against the hook below.
        s.cwd = `/seed/${i}`;
        s.worktree_realpath = `/seed/${i}`;
        s.branch_at_start = 'main';
        // Stagger last_progress_at so recency sort is testable.
        // Newest (i=19) → most recent; oldest (i=0) → 19 minutes earlier.
        const offsetMs = (20 - i) * 60_000;
        s.last_progress_at = new Date(NOW_MS - offsetMs).toISOString();
        p.sessions[sid] = s;
      }
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        transcriptMeta: null,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.source, 'minted');
      assert.equal(r.parentCandidates.length, MAX_PARENT_CANDIDATES, 'must cap at MAX_PARENT_CANDIDATES');
      // MAX_PARENT_CANDIDATES is intentionally <=16 (the spec's suggested
      // upper bound) — current value chosen to keep payloads safely under
      // MAX_EVENT_BYTES after accounting for per-candidate serialized size.
      assert.ok(MAX_PARENT_CANDIDATES > 0 && MAX_PARENT_CANDIDATES <= 16,
        `MAX_PARENT_CANDIDATES must be in (0, 16]; got ${MAX_PARENT_CANDIDATES}`);
      assert.equal(r.parentCandidatesOmittedCount, 20 - MAX_PARENT_CANDIDATES);
    });

    it('sort order: high strong + recent ranks first (cap retains best evidence)', () => {
      // Construct 3 candidates: B has strong=2, A has strong=1 (newer), C
      // has strong=1 (older). Expected order: B, A, C.
      const p = emptyProjection();
      const sA = emptySession(SID_A, NOW_ISO);
      sA.claude_session_ids = [CSID_1];
      sA.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
      sA.cwd = '/work/foo'; // strong hit
      sA.worktree_realpath = '/different';
      sA.branch_at_start = 'main';
      sA.last_progress_at = NOW_ISO; // newest of A/C
      p.sessions[SID_A] = sA;

      const sB = emptySession(SID_B, NOW_ISO);
      sB.claude_session_ids = [CSID_2];
      sB.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
      sB.cwd = '/work/foo';
      sB.worktree_realpath = '/work/foo'; // strong=2
      sB.branch_at_start = 'main';
      sB.last_progress_at = new Date(NOW_MS - 3600_000).toISOString(); // older than A
      p.sessions[SID_B] = sB;

      const sC = emptySession(SID_C, NOW_ISO);
      sC.claude_session_ids = ['csid-c'];
      sC.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
      sC.cwd = '/work/foo';
      sC.worktree_realpath = '/different';
      sC.branch_at_start = 'main';
      sC.last_progress_at = new Date(NOW_MS - 7200_000).toISOString(); // older than A
      p.sessions[SID_C] = sC;

      // capParentCandidates is purely sort+slice; bypass resolveIdentity to
      // assert on order without entangling the accept/mint branching.
      const rows = scanFingerprintCandidates(
        p,
        { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        {
          cwd: '/work/foo',
          worktreeRealpath: '/work/foo',
          branch: 'main',
          now: NOW_MS,
          timeWindowHours: 72,
        },
      );
      const { list, omitted } = capParentCandidates(rows);
      assert.equal(omitted, 0);
      assert.equal(list.length, 3);
      assert.deepEqual(list.map((c) => c.stable_id), [SID_B, SID_A, SID_C],
        'B(strong=2) > A(strong=2 same as recent) > C(strong=2 oldest) — wait, recompute');
      // Note on the assert message above: against /work/foo + /work/foo,
      // sA.cwd hits but sA.worktree_realpath misses → sA strong=1; sB hits
      // both → strong=2; sC matches cwd only → strong=1. Order by strong
      // desc, recency desc: B, A, C. ✓
    });

    it('cap omitted=0 when candidate count <= cap', () => {
      // 3 candidates < 16-cap → no omission count surfaced.
      const p = emptyProjection();
      for (let i = 0; i < 3; i++) {
        const sid = `sess_01970000-0000-7000-8000-0000000000${i.toString(16).padStart(2, '0')}`;
        const s = emptySession(sid, NOW_ISO);
        s.claude_session_ids = [`csid-${i}`];
        s.fingerprints = { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null };
        s.cwd = `/seed/${i}`;
        s.worktree_realpath = `/seed/${i}`;
        s.branch_at_start = 'main';
        s.last_progress_at = NOW_ISO;
        p.sessions[sid] = s;
      }
      const r = resolveIdentity({
        projection: p,
        claudeSessionId: CSID_NEW,
        gitContext: { worktreeRealpath: '/work/foo', branch: 'main' },
        cwd: '/work/foo',
        fingerprints: { first_human_prompt_v1: FP_HUMAN_X, lineage_prefix_v1: null },
        now: NOW_MS,
        mintStableId: mintFn,
      });
      assert.equal(r.parentCandidates.length, 3);
      assert.equal(r.parentCandidatesOmittedCount, 0);
    });

    it('backward compat: replaying old event without parent_candidates_omitted_count does not crash', () => {
      // Pre-patch session_seen events lack parent_candidates_omitted_count.
      // applyEvent must accept them and leave the projection in a sane state
      // (field defaults to 0).
      const projection = emptyProjection();
      const oldEvent = {
        ts: NOW_ISO,
        event_id: 'evt_old',
        op: 'session_seen',
        stable_id: SID_A,
        // No parent_candidates_omitted_count in payload — pre-patch shape.
        payload: {
          claude_session_id: CSID_1,
          identity_resolution: { source: 'minted', confidence: 'minted', matched: {} },
        },
      };
      assert.doesNotThrow(() => applyEvent(projection, oldEvent));
      assert.equal(projection.sessions[SID_A].parent_candidates_omitted_count, 0,
        'missing field defaults to 0');
    });
  });

  describe('collectParentCandidates', () => {
    it('dedup keeps first occurrence per stable_id', () => {
      const out = collectParentCandidates([
        { stableId: SID_A, fingerprintsMatched: ['first_human_prompt_v1'], corroborators: { same_cwd: true, same_worktree_realpath: false, same_branch_at_start: false, within_time_window: false }, corroboratorCount: 1, sessionLastProgressAt: NOW_ISO },
        { stableId: SID_A, fingerprintsMatched: ['lineage_prefix_v1'], corroborators: { same_cwd: false, same_worktree_realpath: false, same_branch_at_start: false, within_time_window: true }, corroboratorCount: 1, sessionLastProgressAt: NOW_ISO },
        { stableId: SID_B, fingerprintsMatched: ['first_human_prompt_v1'], corroborators: { same_cwd: true, same_worktree_realpath: false, same_branch_at_start: false, within_time_window: false }, corroboratorCount: 1, sessionLastProgressAt: NOW_ISO },
      ]);
      assert.equal(out.length, 2);
      assert.equal(out[0].stable_id, SID_A);
      assert.deepEqual(out[0].reason.fingerprints_matched, ['first_human_prompt_v1']);
      assert.equal(out[1].stable_id, SID_B);
    });
  });

  describe('input validation', () => {
    it('throws when mintStableId is missing', () => {
      assert.throws(
        () => resolveIdentity({
          projection: emptyProjection(),
          claudeSessionId: CSID_NEW,
        }),
        /mintStableId callback required/,
      );
    });

    it('throws when claudeSessionId is missing', () => {
      assert.throws(
        () => resolveIdentity({
          projection: emptyProjection(),
          mintStableId: mintFn,
        }),
        /claudeSessionId required/,
      );
    });
  });
});
