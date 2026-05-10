import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTreeJSON } from '../tree.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';
const SID_D = 'sess_dddddddd-4444-7000-8000-000000000004';

function mkSession(stableId, parent = null, overrides = {}) {
  return {
    stable_id: stableId,
    alias: null,
    activity_state: 'active',
    outcome: 'open',
    last_progress_at: '2026-05-09T00:00:00.000Z',
    created_at: '2026-05-09T00:00:00.000Z',
    branch_current: null,
    parent_session_id: parent,
    ...overrides,
  };
}

function mkProjection(sessions) {
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  return { _meta: { schema_version: 2 }, sessions: byId };
}

describe('tree — buildTreeJSON', () => {
  it('builds a single-root tree with two children', () => {
    const proj = mkProjection([
      mkSession(SID_A),
      mkSession(SID_B, SID_A, { created_at: '2026-05-09T01:00:00.000Z' }),
      mkSession(SID_C, SID_A, { created_at: '2026-05-09T02:00:00.000Z' }),
    ]);
    const tree = buildTreeJSON(SID_A, proj);
    assert.equal(tree.stable_id, SID_A);
    assert.equal(tree.children.length, 2);
    // Sort by created_at ASC
    assert.equal(tree.children[0].stable_id, SID_B);
    assert.equal(tree.children[1].stable_id, SID_C);
  });

  it('handles nested grandchildren', () => {
    const proj = mkProjection([
      mkSession(SID_A),
      mkSession(SID_B, SID_A),
      mkSession(SID_C, SID_B),
      mkSession(SID_D, SID_C),
    ]);
    const tree = buildTreeJSON(SID_A, proj);
    assert.equal(tree.stable_id, SID_A);
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].stable_id, SID_B);
    assert.equal(tree.children[0].children[0].stable_id, SID_C);
    assert.equal(tree.children[0].children[0].children[0].stable_id, SID_D);
  });

  it('returns empty children for leaf', () => {
    const proj = mkProjection([mkSession(SID_A)]);
    const tree = buildTreeJSON(SID_A, proj);
    assert.deepEqual(tree.children, []);
  });

  it('detects circular parent references defensively', () => {
    // A → B → A loop
    const proj = mkProjection([
      mkSession(SID_A, SID_B),
      mkSession(SID_B, SID_A),
    ]);
    const tree = buildTreeJSON(SID_A, proj);
    // The recursion eventually marks one node as circular.
    // (B→A appears as a child of A; on recursing into A we detect visited.)
    function findCircular(node) {
      if (node.truncated === 'circular') return true;
      if (Array.isArray(node.children)) {
        return node.children.some(findCircular);
      }
      return false;
    }
    assert.ok(findCircular(tree), `expected truncated='circular' somewhere; got ${JSON.stringify(tree)}`);
  });

  it('exposes session metadata fields on each node', () => {
    const proj = mkProjection([
      mkSession(SID_A, null, { alias: 'main', activity_state: 'idle', outcome: 'done', branch_current: 'main' }),
    ]);
    const tree = buildTreeJSON(SID_A, proj);
    assert.equal(tree.alias, 'main');
    assert.equal(tree.activity_state, 'idle');
    assert.equal(tree.outcome, 'done');
    assert.equal(tree.branch_current, 'main');
  });
});
