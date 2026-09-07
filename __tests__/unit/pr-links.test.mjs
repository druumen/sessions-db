import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PR_LINKS_PER_SESSION,
  MAX_PR_NUMBER,
  applyPrLinkToSession,
  formatPrLink,
  prLinkFromEvent,
  prLinkKey,
  prLinkSeenPayload,
  sessionMatchesPrQuery,
} from '../../lib/pr-links.mjs';
import { applyEvent } from '../../lib/projection.mjs';

const REPO = 'druumen/cn/drummen';
const URL722 = 'https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/722';

const ev = (payload, ts = '2026-09-07T16:00:00.000Z') => ({
  event_id: 'evt_test',
  ts,
  op: 'pr_link_seen',
  stable_id: 'sess_test',
  payload,
});

describe('pr-links.mjs — payload normalisation', () => {
  it('keeps a well-formed record whole', () => {
    const p = prLinkSeenPayload({
      repository: REPO,
      number: 722,
      url: URL722,
      observedAt: '2026-09-07T16:04:20.294Z',
      observedFrom: '/tmp/t.jsonl',
    });
    assert.deepEqual(p, {
      repository: REPO,
      number: 722,
      url: URL722,
      observed_from: '/tmp/t.jsonl',
      observed_at: '2026-09-07T16:04:20.294Z',
    });
  });

  it('refuses a record with no usable number — a link you cannot address is not a link', () => {
    for (const number of [null, undefined, 0, -3, 1.5, '722', MAX_PR_NUMBER + 1, NaN]) {
      assert.equal(prLinkSeenPayload({ repository: REPO, number, url: URL722 }), null,
        `number=${String(number)} must be refused`);
    }
    // ... and the control: the same call with a valid number is NOT null, so
    // the loop above cannot be passing because the builder always returns null.
    assert.notEqual(prLinkSeenPayload({ repository: REPO, number: 1, url: URL722 }), null);
  });

  it('drops a non-http url but keeps the number and repository', () => {
    const p = prLinkSeenPayload({ repository: REPO, number: 722, url: 'javascript:alert(1)' });
    assert.equal(p.url, null, 'a url that could drive the surface rendering it is refused');
    assert.equal(p.number, 722, 'the addressable part survives');
    assert.equal(p.repository, REPO);
  });

  it('drops a repository that is not a forge path, keeping the rest', () => {
    for (const repository of ['has space', 'a\tb', '../etc/passwd'.repeat(30)]) {
      const p = prLinkSeenPayload({ repository, number: 722, url: URL722 });
      assert.equal(p.repository, null, `repository=${JSON.stringify(repository)}`);
      assert.equal(p.number, 722);
    }
    assert.equal(prLinkSeenPayload({ repository: REPO, number: 722 }).repository, REPO);
  });

  it('drops an unparseable observed_at rather than writing it through', () => {
    const p = prLinkSeenPayload({ repository: REPO, number: 722, observedAt: 'not-a-date' });
    assert.equal('observed_at' in p, false);
  });
});

describe('pr-links.mjs — the number bound and the query regex agree', () => {
  it('the largest allowed number can be stored AND found', () => {
    assert.notEqual(prLinkSeenPayload({ repository: REPO, number: MAX_PR_NUMBER }), null);
    const s = { pr_links: [{ repository: REPO, number: MAX_PR_NUMBER, url: null, first_seen_at: null }] };
    assert.equal(sessionMatchesPrQuery(s, String(MAX_PR_NUMBER)), true,
      'a number the writer accepts must be reachable by the reader');
    // One past the bound is refused at the write side, so the reader never
    // needs an opinion about it.
    assert.equal(prLinkSeenPayload({ repository: REPO, number: MAX_PR_NUMBER + 1 }), null);
  });
});

describe('pr-links.mjs — identity and formatting', () => {
  it('identity is (repository, number), not the number alone', () => {
    assert.notEqual(
      prLinkKey({ repository: 'a/b', number: 722 }),
      prLinkKey({ repository: 'c/d', number: 722 }),
    );
    assert.equal(prLinkKey({ repository: null, number: 722 }), '#722');
  });

  it('formats as repo#number, falling back to #number', () => {
    assert.equal(formatPrLink({ repository: REPO, number: 722 }), 'druumen/cn/drummen#722');
    assert.equal(formatPrLink({ repository: null, number: 722 }), '#722');
  });
});

describe('pr-links.mjs — union merge into a session', () => {
  const link = (over = {}) => prLinkFromEvent(ev({
    repository: REPO, number: 722, url: URL722, observed_at: '2026-09-07T16:04:20.294Z', ...over,
  }));

  it('adds a new link', () => {
    const s = {};
    assert.equal(applyPrLinkToSession(s, link()), true);
    assert.deepEqual(s.pr_links, [{
      repository: REPO, number: 722, url: URL722, first_seen_at: '2026-09-07T16:04:20.294Z',
    }]);
  });

  it('re-applying the same link changes nothing (this is what runs every prompt)', () => {
    const s = {};
    applyPrLinkToSession(s, link());
    assert.equal(applyPrLinkToSession(s, link()), false, 'no change → the harvest must not append');
    assert.equal(s.pr_links.length, 1);
  });

  it('keeps the EARLIEST observation, because the question is when it was opened', () => {
    const s = {};
    applyPrLinkToSession(s, link({ observed_at: '2026-09-07T16:19:11.041Z' }));
    assert.equal(applyPrLinkToSession(s, link({ observed_at: '2026-09-07T16:04:20.294Z' })), true);
    assert.equal(s.pr_links[0].first_seen_at, '2026-09-07T16:04:20.294Z');
    // A later observation does not push the timestamp forward.
    assert.equal(applyPrLinkToSession(s, link({ observed_at: '2026-09-07T18:00:00.000Z' })), false);
    assert.equal(s.pr_links[0].first_seen_at, '2026-09-07T16:04:20.294Z');
  });

  it('fills a field that was null without overwriting one that was not', () => {
    const s = {};
    applyPrLinkToSession(s, link({ url: 'javascript:alert(1)' })); // url refused → null
    assert.equal(s.pr_links[0].url, null);
    assert.equal(applyPrLinkToSession(s, link()), true, 'gaining a fact is a change');
    assert.equal(s.pr_links[0].url, URL722);
    // The reverse is not a change: a null url arriving after a real one.
    assert.equal(applyPrLinkToSession(s, link({ url: null })), false);
    assert.equal(s.pr_links[0].url, URL722);
  });

  it('keeps two MRs from the same session apart, in a stable order', () => {
    const s = {};
    applyPrLinkToSession(s, link({ number: 722 }));
    applyPrLinkToSession(s, link({ number: 672 }));
    assert.deepEqual(s.pr_links.map((l) => l.number), [672, 722], 'sorted, so a round-trip is stable');
  });

  it('caps the list rather than letting one writer inflate the projection', () => {
    const s = {};
    for (let n = 1; n <= MAX_PR_LINKS_PER_SESSION + 5; n++) applyPrLinkToSession(s, link({ number: n }));
    assert.equal(s.pr_links.length, MAX_PR_LINKS_PER_SESSION);
  });
});

describe('pr-links.mjs — search predicate', () => {
  const withLinks = (...links) => ({ pr_links: links });
  const s = withLinks(
    { repository: REPO, number: 722, url: URL722, first_seen_at: null },
  );

  it('matches the forms a person types for a number', () => {
    for (const q of ['722', '#722', '!722']) {
      assert.equal(sessionMatchesPrQuery(s, q), true, `query ${q}`);
    }
  });

  it('does NOT widen: a prefix of the number is not a match', () => {
    assert.equal(sessionMatchesPrQuery(s, '72'), false);
    assert.equal(sessionMatchesPrQuery(s, '7220'), false);
  });

  it('matches the repository path and the url by substring', () => {
    assert.equal(sessionMatchesPrQuery(s, 'druumen/cn'), true);
    assert.equal(sessionMatchesPrQuery(s, 'gitlab.tinfant.org'), true);
    assert.equal(sessionMatchesPrQuery(s, 'druumen/cn/drummen#722'), true);
  });

  it('is false for a session with no links, and for an empty query', () => {
    assert.equal(sessionMatchesPrQuery(withLinks(), '722'), false);
    assert.equal(sessionMatchesPrQuery(s, ''), false);
    assert.equal(sessionMatchesPrQuery(s, '   '), false);
  });
});

describe('projection — pr_link_seen', () => {
  const base = () => ({ schema_version: 1, sessions: {}, _meta: {} });

  it('folds the event into pr_links[] and is idempotent on replay', () => {
    const p = base();
    const e = ev(prLinkSeenPayload({ repository: REPO, number: 722, url: URL722, observedAt: '2026-09-07T16:04:20.294Z' }));
    applyEvent(p, e);
    applyEvent(p, e); // same event twice — folding a log twice must land the same state
    const s = p.sessions.sess_test;
    assert.equal(s.pr_links.length, 1);
    assert.equal(s.pr_links[0].number, 722);
    assert.equal(s.pr_links[0].first_seen_at, '2026-09-07T16:04:20.294Z');
  });

  it('falls back to the event ts when the payload carries no observed_at', () => {
    const p = base();
    applyEvent(p, ev({ repository: REPO, number: 9 }, '2026-01-02T03:04:05.000Z'));
    assert.equal(p.sessions.sess_test.pr_links[0].first_seen_at, '2026-01-02T03:04:05.000Z');
  });

  it('does NOT move last_progress_at — harvesting is an observation, not activity', () => {
    const p = base();
    // Seed the session with a real progress event from months ago.
    applyEvent(p, {
      event_id: 'evt_seed', ts: '2026-06-01T00:00:00.000Z', op: 'session_progress',
      stable_id: 'sess_test', payload: { claude_session_id: 'x' },
    });
    assert.equal(p.sessions.sess_test.last_progress_at, '2026-06-01T00:00:00.000Z');

    // Backfilling a link and a name today must not date the session to today:
    // `sessions-db harvest` folds hundreds of these at once.
    for (const op of ['pr_link_seen', 'name_set']) {
      applyEvent(p, {
        event_id: `evt_${op}`, ts: '2026-09-07T12:00:00.000Z', op, stable_id: 'sess_test',
        payload: op === 'name_set'
          ? { channel: 'cc_ai_title', value: 'harvested today', source: 'llm' }
          : prLinkSeenPayload({ repository: REPO, number: 722 }),
      });
      assert.equal(p.sessions.sess_test.last_progress_at, '2026-06-01T00:00:00.000Z',
        `${op} must not bump last_progress_at`);
    }
    // The observation still landed — this is not "the event was ignored".
    assert.equal(p.sessions.sess_test.display_name, 'harvested today');
    assert.equal(p.sessions.sess_test.pr_links.length, 1);

    // Control: the exemption is per-op, not a blanket stop. A real progress
    // event on the same projection still moves it.
    applyEvent(p, {
      event_id: 'evt_live', ts: '2026-09-07T13:00:00.000Z', op: 'session_progress',
      stable_id: 'sess_test', payload: { claude_session_id: 'x' },
    });
    assert.equal(p.sessions.sess_test.last_progress_at, '2026-09-07T13:00:00.000Z');
  });

  it('drops an event whose payload has no usable number instead of storing a hole', () => {
    const p = base();
    applyEvent(p, ev({ repository: REPO, number: 'not-a-number' }));
    assert.deepEqual(p.sessions.sess_test.pr_links, []);
  });
});
