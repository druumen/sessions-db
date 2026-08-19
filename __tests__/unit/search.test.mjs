import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionMetadataFields,
  matchSessionMetadata,
  matchCurrentNames,
  matchNameHistory,
  recordText,
  extractSnippet,
} from '../../lib/search.mjs';
import { foldNameHistory } from '../../lib/names.mjs';

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

describe('search — names on the metadata tier', () => {
  it('indexes the current value of every channel, labelled by channel', () => {
    const fields = sessionMetadataFields({
      stable_id: 'sess_x',
      names: [
        { channel: 'cc_ai_title', value: 'Fix HTTP 400 error', set_at: 't', source: 'llm' },
        { channel: 'cc_custom_title', value: 'typed by hand', set_at: 't', source: 'human' },
        { channel: 'agent_name', value: 'a-badge', set_at: 't', source: 'harvest' },
      ],
    });
    const byLabel = Object.fromEntries(fields);
    assert.equal(byLabel['name:cc_ai_title'], 'Fix HTTP 400 error');
    assert.equal(byLabel['name:cc_custom_title'], 'typed by hand');
    // agent_name is not in the DISPLAY chain, but it is still searchable — you
    // should be able to find a session by the agent that ran it.
    assert.equal(byLabel['name:agent_name'], 'a-badge');
  });

  it('closes the ai_title hole on projections that predate names[]', () => {
    // 355 of 626 records on the reference database carry an ai_title and no
    // names[] — the title the user actually sees, previously unsearchable.
    const hits = matchSessionMetadata({ stable_id: 'sess_x', ai_title: 'Fix HTTP 400 error' }, 'http 400');
    assert.deepEqual(hits, ['name:cc_ai_title']);
  });

  it('does not duplicate the alias under a second label', () => {
    // `alias` keeps its historical label so existing matched_in consumers do
    // not have to learn a new one.
    const hits = matchSessionMetadata({
      stable_id: 'sess_x',
      alias: 'pricing-overhaul',
      names: [{ channel: 'alias', value: 'pricing-overhaul', set_at: 't', source: 'human' }],
    }, 'pricing');
    assert.deepEqual(hits, ['alias']);
  });

  it('matchCurrentNames returns the matched value, not just a label', () => {
    const session = {
      stable_id: 'sess_x',
      first_prompt_preview: 'a query about pricing',
      names: [{ channel: 'cc_ai_title', value: 'Pricing model rewrite', set_at: 'T1', source: 'llm' }],
    };
    assert.deepEqual(matchCurrentNames(session, 'pricing'), [{
      channel: 'cc_ai_title', value: 'Pricing model rewrite',
      set_at: 'T1', source: 'llm', kind: 'current',
    }]);
    // first_prompt is the display fallback, not a name anybody gave it, and it
    // is already reported under its own label.
    assert.equal(matchCurrentNames(session, 'a query').length, 0);
  });
});

describe('search — matchNameHistory', () => {
  // Real ISO timestamps, not placeholders: `set_at` is typed `Iso8601|null`
  // and an unparseable ts now falls back to null instead of being carried
  // through verbatim.
  const TS_1 = '2026-08-01T10:00:00.000Z';
  const TS_2 = '2026-08-02T10:00:00.000Z';
  const events = [
    { ts: TS_1, event_id: 'e1', op: 'ai_title_seen', stable_id: 'sess_x', payload: { ai_title: 'Fix HTTP 400 error' } },
    { ts: TS_2, event_id: 'e2', op: 'name_set', stable_id: 'sess_x', payload: { channel: 'cc_ai_title', value: 'Analyze Knowledge Spine', source: 'llm' } },
  ];

  it('matches a superseded value and marks it historical', () => {
    const byChannel = foldNameHistory(events).get('sess_x');
    assert.deepEqual(matchNameHistory(byChannel, 'http 400'), [{
      channel: 'cc_ai_title', value: 'Fix HTTP 400 error',
      set_at: TS_1, source: 'llm', kind: 'history',
    }]);
  });

  it('excludes the current value — that tier is the metadata pass', () => {
    const byChannel = foldNameHistory(events).get('sess_x');
    assert.deepEqual(matchNameHistory(byChannel, 'knowledge spine'), []);
  });

  it('is a no-op on empty input', () => {
    assert.deepEqual(matchNameHistory(null, 'x'), []);
    assert.deepEqual(matchNameHistory(new Map(), ''), []);
  });
});
