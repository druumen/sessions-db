import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchByMetadata } from '../../cli/search.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';

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
    first_prompt_preview: null,
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

describe('search — searchByMetadata (pure)', () => {
  it('matches across alias / first_prompt and reports matched_in', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'Pricing Overhaul' }),
      mkSession(SID_B, { first_prompt_preview: 'fix the pricing bug' }),
      mkSession(SID_C, { alias: 'unrelated' }),
    ]);
    const r = searchByMetadata(proj, 'pricing');
    const ids = r.map((x) => x.session.stable_id).sort();
    assert.deepEqual(ids, [SID_A, SID_B].sort());
    const a = r.find((x) => x.session.stable_id === SID_A);
    assert.deepEqual(a.matched_in, ['alias']);
  });

  it('honors the state filter', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'pricing', activity_state: 'active' }),
      mkSession(SID_B, { alias: 'pricing', activity_state: 'archived' }),
    ]);
    const r = searchByMetadata(proj, 'pricing', { state: 'archived' });
    assert.equal(r.length, 1);
    assert.equal(r[0].session.stable_id, SID_B);
  });

  it('sorts by last_progress_at DESC', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'x', last_progress_at: '2026-05-01T00:00:00.000Z' }),
      mkSession(SID_B, { alias: 'x', last_progress_at: '2026-05-20T00:00:00.000Z' }),
    ]);
    const r = searchByMetadata(proj, 'x');
    assert.deepEqual(
      r.map((x) => x.session.stable_id),
      [SID_B, SID_A],
    );
  });

  it('empty on no match', () => {
    const proj = mkProjection([mkSession(SID_A, { alias: 'foo' })]);
    assert.deepEqual(searchByMetadata(proj, 'zzz'), []);
  });
});
