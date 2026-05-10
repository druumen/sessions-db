import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatJSON,
  formatSessionTable,
  formatTree,
  relTime,
  shouldUseColor,
  truncateStableId,
} from '../../cli/format.mjs';

// IDs are constructed so the first 22 chars (the truncation slice
// `sess_XXXXXXXX-AAAA-7BBB`) differ. This lets tree-rendering tests assert
// on the truncated form without matching multiple sessions by accident.
const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';

function mkSession(overrides = {}) {
  return {
    stable_id: SID_A,
    alias: null,
    activity_state: 'active',
    outcome: 'open',
    last_progress_at: '2026-05-09T00:00:00.000Z',
    branch_current: 'main',
    cwd: '/tmp/x',
    parent_session_id: null,
    created_at: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('format.mjs', () => {
  describe('truncateStableId', () => {
    it('truncates a long sess_ id to first 22 chars', () => {
      const t = truncateStableId(SID_A);
      assert.equal(t.length, 22);
      assert.equal(t, SID_A.slice(0, 22));
    });

    it('returns short ids unchanged', () => {
      assert.equal(truncateStableId('sess_short'), 'sess_short');
    });

    it('handles non-string input', () => {
      assert.equal(truncateStableId(undefined), '<invalid>');
    });
  });

  describe('relTime', () => {
    const now = Date.parse('2026-05-09T12:00:00.000Z');
    it('returns "just now" for very recent', () => {
      assert.equal(relTime('2026-05-09T11:59:58.000Z', now), 'just now');
    });
    it('seconds', () => {
      assert.equal(relTime('2026-05-09T11:59:30.000Z', now), '30s ago');
    });
    it('minutes', () => {
      assert.equal(relTime('2026-05-09T11:30:00.000Z', now), '30m ago');
    });
    it('hours', () => {
      assert.equal(relTime('2026-05-09T09:00:00.000Z', now), '3h ago');
    });
    it('days', () => {
      assert.equal(relTime('2026-05-06T12:00:00.000Z', now), '3d ago');
    });
    it('months', () => {
      // 90+ days back should land in months bucket (Math.floor(days/30))
      assert.equal(relTime('2026-01-09T12:00:00.000Z', now), '4mo ago');
    });
    it('years', () => {
      assert.equal(relTime('2024-05-09T12:00:00.000Z', now), '2y ago');
    });
    it('handles invalid input', () => {
      assert.equal(relTime(null), '-');
      assert.equal(relTime('not-a-date'), '-');
    });
    it('returns "in the future" for future ts', () => {
      assert.equal(relTime('2026-05-10T12:00:00.000Z', now), 'in the future');
    });
  });

  describe('formatSessionTable', () => {
    it('returns "(no sessions matched)" when empty', () => {
      const out = formatSessionTable([]);
      assert.equal(out, '(no sessions matched)\n');
    });

    it('renders header + rows aligned', () => {
      const out = formatSessionTable([
        mkSession({ stable_id: SID_A, alias: 'demo' }),
        mkSession({ stable_id: SID_B, alias: null, activity_state: 'idle' }),
      ], { useColor: false, now: Date.parse('2026-05-09T01:00:00.000Z') });
      // Header line first
      assert.match(out, /^stable_id +alias +state +outcome +last_progress +branch +cwd/);
      assert.match(out, /demo/);
      assert.match(out, /idle/);
      // No trailing whitespace per row (we trimEnd).
      for (const line of out.split('\n').filter(Boolean)) {
        assert.equal(line, line.trimEnd());
      }
    });

    it('truncates long branch + cwd', () => {
      const longBranch = 'feat/' + 'x'.repeat(100);
      const longCwd = '/' + 'long-dir/'.repeat(20);
      const out = formatSessionTable([
        mkSession({ branch_current: longBranch, cwd: longCwd }),
      ], { useColor: false });
      assert.ok(out.includes('...'), 'should ellipsize long values');
    });
  });

  describe('formatTree', () => {
    function mkProjection(parentMap) {
      // parentMap = { stable_id: parent_session_id|null, ... }
      const sessions = {};
      for (const [sid, parent] of Object.entries(parentMap)) {
        sessions[sid] = mkSession({
          stable_id: sid,
          parent_session_id: parent,
          alias: null,
          created_at: `2026-05-09T0${Object.keys(sessions).length}:00:00.000Z`,
        });
      }
      return { _meta: {}, sessions };
    }

    it('renders single root with children', () => {
      const proj = mkProjection({
        [SID_A]: null,
        [SID_B]: SID_A,
        [SID_C]: SID_A,
      });
      const out = formatTree(SID_A, proj, { useColor: false });
      assert.match(out, new RegExp(SID_A.slice(0, 22)));
      // Two children rendered with tree connectors
      assert.match(out, /├── /);
      assert.match(out, /└── /);
    });

    it('renders nested grandchildren', () => {
      const proj = mkProjection({
        [SID_A]: null,
        [SID_B]: SID_A,
        [SID_C]: SID_B,
      });
      const out = formatTree(SID_A, proj, { useColor: false });
      // grandchild line should be indented under parent
      const lines = out.split('\n').filter(Boolean);
      const grandchildLine = lines.find((l) => l.includes(SID_C.slice(0, 22)));
      assert.ok(grandchildLine, 'grandchild rendered');
      assert.ok(grandchildLine.startsWith('    └──') || grandchildLine.startsWith('│   └──'),
        `expected indented grandchild, got: ${grandchildLine}`);
    });

    it('returns error line when root not found', () => {
      const out = formatTree('sess_missing-XXXX', mkProjection({}), { useColor: false });
      assert.match(out, /^error: stable_id not found:/);
    });

    it('detects circular parent reference', () => {
      // A → B → A (forced)
      const proj = mkProjection({
        [SID_A]: SID_B,
        [SID_B]: SID_A,
      });
      const out = formatTree(SID_A, proj, { useColor: false });
      assert.match(out, /circular reference/);
    });
  });

  describe('formatJSON', () => {
    it('pretty-prints with 2-space indent and trailing newline', () => {
      const out = formatJSON({ a: 1, b: [2, 3] });
      assert.equal(out, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
    });
  });

  describe('shouldUseColor', () => {
    it('off when not a TTY', () => {
      assert.equal(shouldUseColor(false, {}, false), false);
    });
    it('off when NO_COLOR set', () => {
      assert.equal(shouldUseColor(true, { NO_COLOR: '1' }, false), false);
    });
    it('off when --no-color flag', () => {
      assert.equal(shouldUseColor(true, {}, true), false);
    });
    it('on by default in TTY', () => {
      assert.equal(shouldUseColor(true, {}, false), true);
    });
  });
});
