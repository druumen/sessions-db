import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionMetadataFields,
  matchSessionMetadata,
  recordText,
  extractSnippet,
} from '../../lib/search.mjs';

describe('search — sessionMetadataFields', () => {
  it('collects non-empty labelled fields, skips empties', () => {
    const fields = sessionMetadataFields({
      stable_id: 'sess_x',
      alias: 'pricing',
      first_prompt_preview: '',
      branch_current: 'master',
      branch_at_start: null,
      cwd: '/repo',
      tasks: ['feat-foo.md'],
      projects: [],
      claude_session_ids: ['uuid-1'],
    });
    const labels = fields.map(([l]) => l);
    assert.ok(labels.includes('stable_id'));
    assert.ok(labels.includes('alias'));
    assert.ok(labels.includes('branch'));
    assert.ok(labels.includes('cwd'));
    assert.ok(labels.includes('task'));
    assert.ok(labels.includes('claude_session_id'));
    assert.ok(!labels.includes('first_prompt')); // empty skipped
  });
});

describe('search — matchSessionMetadata', () => {
  const s = {
    stable_id: 'sess_abc',
    alias: 'Pricing Overhaul',
    first_prompt_preview: 'help me with the RLS policy',
    branch_current: 'feat/rls',
    cwd: '/Users/x/drummen',
    tasks: ['feat-pricing-04052026.md'],
    projects: [],
    claude_session_ids: ['9c6ba991-ffe5'],
  };

  it('matches case-insensitively and reports field labels', () => {
    assert.deepEqual(matchSessionMetadata(s, 'pricing').sort(), ['alias', 'task']);
    // 'RLS' hits both the first prompt ("RLS policy") and branch ("feat/rls").
    assert.deepEqual(matchSessionMetadata(s, 'RLS').sort(), ['branch', 'first_prompt']);
    assert.deepEqual(matchSessionMetadata(s, 'feat/rls'), ['branch']);
    assert.deepEqual(matchSessionMetadata(s, '9c6ba991'), ['claude_session_id']);
  });

  it('returns [] on no match / empty query / bad input', () => {
    assert.deepEqual(matchSessionMetadata(s, 'zzzznomatch'), []);
    assert.deepEqual(matchSessionMetadata(s, ''), []);
    assert.deepEqual(matchSessionMetadata(null, 'x'), []);
  });
});

describe('search — recordText', () => {
  it('extracts string content from user/assistant', () => {
    assert.equal(recordText({ type: 'user', message: { content: 'hello world' } }), 'hello world');
  });

  it('joins text blocks, ignores non-text blocks', () => {
    const rec = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: 'more' },
        ],
      },
    };
    assert.equal(recordText(rec), 'visible answer more');
  });

  it('returns "" for non-message records', () => {
    assert.equal(recordText({ type: 'queue-operation' }), '');
    assert.equal(recordText({ type: 'attachment' }), '');
    assert.equal(recordText(null), '');
  });
});

describe('search — extractSnippet', () => {
  it('returns a trimmed snippet with ellipses around the match', () => {
    const text = 'a'.repeat(100) + ' NEEDLE ' + 'b'.repeat(100);
    const snip = extractSnippet(text, 'needle', 10);
    assert.ok(snip.includes('NEEDLE'));
    assert.ok(snip.startsWith('…'));
    assert.ok(snip.endsWith('…'));
  });

  it('no ellipsis when match is near the edges', () => {
    const snip = extractSnippet('NEEDLE at start', 'NEEDLE', 60);
    assert.equal(snip, 'NEEDLE at start');
  });

  it('collapses whitespace', () => {
    assert.equal(extractSnippet('foo\n\n  NEEDLE \t bar', 'needle', 60), 'foo NEEDLE bar');
  });

  it('returns null when not found / empty', () => {
    assert.equal(extractSnippet('no match here', 'needle'), null);
    assert.equal(extractSnippet('', 'needle'), null);
    assert.equal(extractSnippet('text', ''), null);
  });
});
