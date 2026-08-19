import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_AGENT_NAME,
  CHANNEL_ALIAS,
  CHANNEL_CC_AI_TITLE,
  CHANNEL_CC_CUSTOM_TITLE,
  CHANNEL_FIRST_PROMPT,
  MAX_CHANNELS_PER_SESSION,
  MAX_NAME_VALUE_LEN,
  MAX_OBSERVED_FROM_LEN,
  NAME_PRECEDENCE,
  SOURCE_HARVEST,
  SOURCE_HUMAN,
  SOURCE_LLM,
  applyNameToSession,
  currentNameValue,
  displayNameForSession,
  findNameEntry,
  foldNameHistory,
  hasAnyName,
  isIso8601,
  isKnownChannel,
  isValidChannel,
  isValidNameValue,
  isValidSource,
  nameChangeFromEvent,
  nameSetPayload,
  nameValuesFromSession,
  normalizeObservedFrom,
  resolveDisplayName,
  sortChannels,
  splitChannelHistory,
} from '../../lib/names.mjs';

const TS_A = '2026-08-01T10:00:00.000Z';
const TS_B = '2026-08-02T10:00:00.000Z';
const SID = 'sess_01970000-0000-7000-8000-000000000001';

function evt(op, payload, { ts = TS_A, stableId = SID, id = 'e1' } = {}) {
  return { ts, event_id: `evt_${id}`, op, stable_id: stableId, payload };
}

describe('names.mjs — validation bounds', () => {
  it('accepts identifier-shaped channels within the length cap', () => {
    assert.equal(isValidChannel('alias'), true);
    assert.equal(isValidChannel('cc_custom_title'), true);
    assert.equal(isValidChannel('dru.cli-v2'), true);
    assert.equal(isValidChannel('a'.repeat(64)), true);
  });

  it('rejects channels that would turn a name entry into a payload lane', () => {
    // The open channel set is only safe while the token itself is bounded:
    // without these, `channel` is an arbitrary-length arbitrary-bytes field
    // that happens to be stored per session.
    assert.equal(isValidChannel('a'.repeat(65)), false, 'over length cap');
    assert.equal(isValidChannel(''), false);
    assert.equal(isValidChannel('has space'), false);
    assert.equal(isValidChannel('_leading'), false, 'must start alphanumeric');
    assert.equal(isValidChannel('new\nline'), false);
    assert.equal(isValidChannel('quote"'), false);
    assert.equal(isValidChannel(null), false);
    assert.equal(isValidChannel(42), false);
  });

  it('applies the same rules to source, with its own (tighter) cap', () => {
    assert.equal(isValidSource('human'), true);
    assert.equal(isValidSource('a'.repeat(32)), true);
    assert.equal(isValidSource('a'.repeat(33)), false);
    assert.equal(isValidSource('two words'), false);
  });

  it('treats null as a valid value (a clear) but empty string as invalid', () => {
    // Clearing must be expressible, because "somebody removed this name" is
    // information that a delete would destroy. An empty string is not a way to
    // say that — it is a malformed name.
    assert.equal(isValidNameValue(null), true);
    assert.equal(isValidNameValue(''), false);
    assert.equal(isValidNameValue('x'), true);
    assert.equal(isValidNameValue('x'.repeat(MAX_NAME_VALUE_LEN)), true);
    assert.equal(isValidNameValue('x'.repeat(MAX_NAME_VALUE_LEN + 1)), false);
    assert.equal(isValidNameValue(undefined), false);
    assert.equal(isValidNameValue(123), false);
  });

  it('isKnownChannel is about display ordering only — never about storage', () => {
    assert.equal(isKnownChannel(CHANNEL_ALIAS), true);
    assert.equal(isKnownChannel('mcp_label'), false);
    // ...and an unknown channel is still perfectly valid to store:
    assert.equal(isValidChannel('mcp_label'), true);
  });
});

describe('names.mjs — precedence engine', () => {
  it('follows alias > cc_custom_title > cc_ai_title > first_prompt', () => {
    const all = {
      [CHANNEL_ALIAS]: 'A',
      [CHANNEL_CC_CUSTOM_TITLE]: 'C',
      [CHANNEL_CC_AI_TITLE]: 'I',
      [CHANNEL_FIRST_PROMPT]: 'P',
    };
    assert.deepEqual(resolveDisplayName(all), {
      display_name: 'A', display_name_channel: CHANNEL_ALIAS,
    });
    const noAlias = { ...all, [CHANNEL_ALIAS]: null };
    assert.deepEqual(resolveDisplayName(noAlias), {
      display_name: 'C', display_name_channel: CHANNEL_CC_CUSTOM_TITLE,
    });
    const noHuman = { ...noAlias, [CHANNEL_CC_CUSTOM_TITLE]: null };
    assert.deepEqual(resolveDisplayName(noHuman), {
      display_name: 'I', display_name_channel: CHANNEL_CC_AI_TITLE,
    });
    const nothingButPrompt = { ...noHuman, [CHANNEL_CC_AI_TITLE]: null };
    assert.deepEqual(resolveDisplayName(nothingButPrompt), {
      display_name: 'P', display_name_channel: CHANNEL_FIRST_PROMPT,
    });
  });

  it('keeps agent_name OUT of the chain even when it is the only name', () => {
    // Measured on the reference machine: all 7 sessions carrying an
    // `agent-name` record had it byte-identical to their ai_title. Promoting
    // it buys nothing and adds a way for the display to flip between two
    // spellings of the same string. It is a badge, not a name.
    const only = { [CHANNEL_AGENT_NAME]: 'side-session-refactor' };
    assert.deepEqual(resolveDisplayName(only), {
      display_name: null, display_name_channel: null,
    });
    assert.equal(NAME_PRECEDENCE.includes(CHANNEL_AGENT_NAME), false);
  });

  it('returns nulls rather than inventing a placeholder', () => {
    assert.deepEqual(resolveDisplayName({}), {
      display_name: null, display_name_channel: null,
    });
    assert.deepEqual(resolveDisplayName(null), {
      display_name: null, display_name_channel: null,
    });
  });

  it('skips whitespace-only values as if unset', () => {
    const r = resolveDisplayName({
      [CHANNEL_ALIAS]: '   ',
      [CHANNEL_CC_AI_TITLE]: 'real',
    });
    assert.deepEqual(r, { display_name: 'real', display_name_channel: CHANNEL_CC_AI_TITLE });
  });

  it('accepts a caller-supplied precedence without mutating the default', () => {
    const values = { [CHANNEL_ALIAS]: 'A', [CHANNEL_CC_AI_TITLE]: 'I' };
    const r = resolveDisplayName(values, { precedence: [CHANNEL_CC_AI_TITLE, CHANNEL_ALIAS] });
    assert.equal(r.display_name, 'I');
    assert.equal(resolveDisplayName(values).display_name, 'A', 'default chain unchanged');
  });

  it('lets a consumer substitute a fresher value for one channel', () => {
    // This is the whole reason the engine takes a map instead of a session.
    // sessions-db owns name HISTORY; the Claude Code transcript owns the
    // CURRENT value of its own channels, and the copy here only refreshes on
    // SessionStart. A consumer that just read a newer custom-title off disk
    // must be able to use the shared rule without being pushed back onto the
    // stale copy — otherwise "one rule" and "no stale data" cannot both hold.
    const session = {
      names: [
        { channel: CHANNEL_CC_CUSTOM_TITLE, value: 'stale', set_at: TS_A, source: SOURCE_HUMAN },
      ],
      first_prompt_preview: 'p',
    };
    assert.equal(displayNameForSession(session).display_name, 'stale');
    const fresh = displayNameForSession(session, {
      overrides: { [CHANNEL_CC_CUSTOM_TITLE]: 'typed just now' },
    });
    assert.deepEqual(fresh, {
      display_name: 'typed just now',
      display_name_channel: CHANNEL_CC_CUSTOM_TITLE,
    });
  });

  it('an override that clears a channel falls through to the next one', () => {
    const session = { names: [{ channel: CHANNEL_ALIAS, value: 'old-alias', set_at: TS_A, source: SOURCE_HUMAN }] };
    session.first_prompt_preview = 'the first thing asked';
    const r = displayNameForSession(session, { overrides: { [CHANNEL_ALIAS]: null } });
    assert.deepEqual(r, {
      display_name: 'the first thing asked',
      display_name_channel: CHANNEL_FIRST_PROMPT,
    });
  });
});

describe('names.mjs — reading values off a session record', () => {
  it('falls back to the legacy top-level fields for pre-0.3.0 records', () => {
    // A projection written before names[] existed still has alias / ai_title.
    // Without this fallback every one of those sessions reads as unnamed —
    // and the hook's change detection would re-emit an event for all of them.
    const legacy = { alias: 'legacy-alias', ai_title: 'legacy-title', first_prompt_preview: 'p' };
    assert.equal(currentNameValue(legacy, CHANNEL_ALIAS), 'legacy-alias');
    assert.equal(currentNameValue(legacy, CHANNEL_CC_AI_TITLE), 'legacy-title');
    assert.equal(currentNameValue(legacy, CHANNEL_CC_CUSTOM_TITLE), null);
    assert.deepEqual(nameValuesFromSession(legacy), {
      [CHANNEL_ALIAS]: 'legacy-alias',
      [CHANNEL_CC_AI_TITLE]: 'legacy-title',
      [CHANNEL_FIRST_PROMPT]: 'p',
    });
    assert.equal(displayNameForSession(legacy).display_name, 'legacy-alias');
  });

  it('a names[] entry wins over the legacy mirror, including when cleared', () => {
    const session = {
      alias: 'stale-mirror',
      names: [{ channel: CHANNEL_ALIAS, value: null, set_at: TS_B, source: SOURCE_HUMAN }],
    };
    assert.equal(currentNameValue(session, CHANNEL_ALIAS), null);
  });

  it('findNameEntry tolerates records with no names at all', () => {
    assert.equal(findNameEntry({}, CHANNEL_ALIAS), null);
    assert.equal(findNameEntry(null, CHANNEL_ALIAS), null);
  });
});

describe('names.mjs — applyNameToSession (projection side)', () => {
  it('stores one entry per channel and counts sets instead of keeping history', () => {
    // The flatness invariant: renaming N times must not grow the record. The
    // projection is read whole on every cockpit refresh, so "history is
    // unbounded" must not mean "the cache is unbounded".
    const session = {};
    for (let i = 0; i < 25; i++) {
      applyNameToSession(session, {
        channel: CHANNEL_CC_AI_TITLE, value: `title ${i}`, source: SOURCE_LLM, set_at: TS_A,
      });
    }
    assert.equal(session.names.length, 1);
    assert.equal(session.names[0].value, 'title 24');
    assert.equal(session.names[0].set_count, 25);
  });

  it('preserves an unknown channel verbatim', () => {
    const session = {};
    const applied = applyNameToSession(session, {
      channel: 'from_the_future', value: 'X', source: 'some_new_source', set_at: TS_A,
    });
    assert.equal(applied, true);
    assert.deepEqual(session.names[0], {
      channel: 'from_the_future', value: 'X', set_at: TS_A,
      source: 'some_new_source', set_count: 1,
    });
  });

  it('refuses malformed input — unknown is kept, invalid is not', () => {
    const session = {};
    assert.equal(applyNameToSession(session, { channel: 'bad channel', value: 'x', source: SOURCE_HUMAN }), false);
    assert.equal(applyNameToSession(session, { channel: CHANNEL_ALIAS, value: 'x', source: 'bad source' }), false);
    assert.equal(applyNameToSession(session, { channel: CHANNEL_ALIAS, value: 'x'.repeat(MAX_NAME_VALUE_LEN + 1), source: SOURCE_HUMAN }), false);
    assert.deepEqual(session.names ?? [], []);
  });

  it('caps NEW channels per session but never stops an existing one updating', () => {
    const session = {};
    for (let i = 0; i < MAX_CHANNELS_PER_SESSION; i++) {
      assert.equal(
        applyNameToSession(session, { channel: `ch${i}`, value: 'v', source: SOURCE_HARVEST, set_at: TS_A }),
        true,
      );
    }
    assert.equal(
      applyNameToSession(session, { channel: 'one_too_many', value: 'v', source: SOURCE_HARVEST, set_at: TS_A }),
      false,
      'new channel past the cap is refused',
    );
    assert.equal(
      applyNameToSession(session, { channel: 'ch0', value: 'updated', source: SOURCE_HARVEST, set_at: TS_B }),
      true,
      'an existing channel keeps updating past the cap',
    );
    assert.equal(session.names.length, MAX_CHANNELS_PER_SESSION);
    assert.equal(findNameEntry(session, 'ch0').value, 'updated');
  });

  it('keeps the previous observed_from when a later set does not carry one', () => {
    const session = {};
    applyNameToSession(session, {
      channel: CHANNEL_CC_AI_TITLE, value: 'a', source: SOURCE_LLM, set_at: TS_A,
      observed_from: '/t/one.jsonl',
    });
    applyNameToSession(session, {
      channel: CHANNEL_CC_AI_TITLE, value: 'b', source: SOURCE_LLM, set_at: TS_B,
    });
    assert.equal(findNameEntry(session, CHANNEL_CC_AI_TITLE).observed_from, '/t/one.jsonl');
  });
});

describe('names.mjs — nameChangeFromEvent (the single op → channel mapping)', () => {
  it('maps the legacy alias_set op onto the alias channel, authored by a human', () => {
    const change = nameChangeFromEvent(evt('alias_set', { alias: 'mainline' }));
    assert.deepEqual(change, {
      channel: CHANNEL_ALIAS, value: 'mainline', source: SOURCE_HUMAN,
      set_at: TS_A, observed_from: null, op: 'alias_set', event_id: 'evt_e1',
    });
  });

  it('maps the legacy ai_title_seen op, carrying its provenance across', () => {
    // This is what makes the 406 rows already on disk into history for free:
    // both the transcript path and the observation time survive the rename of
    // the op, so no information is invented and none is dropped.
    const change = nameChangeFromEvent(evt('ai_title_seen', {
      ai_title: 'Fix HTTP 400 error',
      source_transcript: '/t/a.jsonl',
      observed_at: TS_B,
    }));
    assert.deepEqual(change, {
      channel: CHANNEL_CC_AI_TITLE, value: 'Fix HTTP 400 error', source: SOURCE_LLM,
      set_at: TS_B, observed_from: '/t/a.jsonl', op: 'ai_title_seen', event_id: 'evt_e1',
    });
  });

  it('prefers observed_at over the event ts, and falls back to ts', () => {
    assert.equal(nameChangeFromEvent(evt('name_set', {
      channel: CHANNEL_ALIAS, value: 'v', source: SOURCE_HUMAN, observed_at: TS_B,
    })).set_at, TS_B);
    assert.equal(nameChangeFromEvent(evt('name_set', {
      channel: CHANNEL_ALIAS, value: 'v', source: SOURCE_HUMAN,
    })).set_at, TS_A);
  });

  it('distinguishes "cleared" (null) from "says nothing" (missing)', () => {
    const cleared = nameChangeFromEvent(evt('alias_set', { alias: null }));
    assert.equal(cleared.value, null);
    assert.equal(nameChangeFromEvent(evt('alias_set', {})), null, 'no alias key = no change');
  });

  it('defaults a missing source to harvest rather than dropping the name', () => {
    const change = nameChangeFromEvent(evt('name_set', { channel: 'x_channel', value: 'v' }));
    assert.equal(change.source, SOURCE_HARVEST);
  });

  it('returns null for ops that carry no name, and for malformed payloads', () => {
    assert.equal(nameChangeFromEvent(evt('session_seen', { cwd: '/x' })), null);
    assert.equal(nameChangeFromEvent(evt('name_set', { channel: 'bad channel', value: 'v' })), null);
    assert.equal(nameChangeFromEvent(evt('name_set', { channel: 'ok', value: '' })), null);
    assert.equal(nameChangeFromEvent(evt('name_set', { value: 'v' })), null, 'channel required');
    assert.equal(nameChangeFromEvent(null), null);
  });

  it('nameSetPayload round-trips through nameChangeFromEvent', () => {
    const payload = nameSetPayload({
      channel: CHANNEL_CC_CUSTOM_TITLE, value: 'typed', source: SOURCE_HUMAN,
      observedFrom: '/t/b.jsonl', observedAt: TS_B,
    });
    const change = nameChangeFromEvent(evt('name_set', payload));
    assert.equal(change.channel, CHANNEL_CC_CUSTOM_TITLE);
    assert.equal(change.value, 'typed');
    assert.equal(change.source, SOURCE_HUMAN);
    assert.equal(change.observed_from, '/t/b.jsonl');
    assert.equal(change.set_at, TS_B);
  });
});

describe('names.mjs — foldNameHistory', () => {
  const events = [
    evt('session_seen', { cwd: '/x' }, { id: '0' }),
    evt('ai_title_seen', { ai_title: 'first title', observed_at: TS_A }, { id: '1' }),
    evt('name_set', { channel: CHANNEL_CC_AI_TITLE, value: 'second title', source: SOURCE_LLM }, { ts: TS_B, id: '2' }),
    evt('name_set', { channel: CHANNEL_CC_CUSTOM_TITLE, value: 'typed', source: SOURCE_HUMAN }, { ts: TS_B, id: '3' }),
  ];

  it('groups by session then channel, in event order', () => {
    const hist = foldNameHistory(events);
    const byChannel = hist.get(SID);
    assert.deepEqual([...byChannel.keys()].sort(), [CHANNEL_CC_AI_TITLE, CHANNEL_CC_CUSTOM_TITLE]);
    assert.deepEqual(
      byChannel.get(CHANNEL_CC_AI_TITLE).map((e) => e.value),
      ['first title', 'second title'],
    );
  });

  it('mixes legacy and new ops into ONE channel timeline', () => {
    // The rename of the op must not fork the history: an ai_title_seen from
    // May and a name_set from August are the same channel being set twice.
    const entries = foldNameHistory(events).get(SID).get(CHANNEL_CC_AI_TITLE);
    assert.deepEqual(entries.map((e) => e.op), ['ai_title_seen', 'name_set']);
  });

  it('splits the last entry per channel as current, the rest as history', () => {
    const entries = foldNameHistory(events).get(SID).get(CHANNEL_CC_AI_TITLE);
    const { current, history } = splitChannelHistory(entries);
    assert.equal(current.value, 'second title');
    assert.deepEqual(history.map((h) => h.value), ['first title']);
    assert.deepEqual(splitChannelHistory([]), { current: null, history: [] });
  });

  it('reports a name used, dropped, and restored on BOTH sides of the split', () => {
    const back = [
      evt('name_set', { channel: CHANNEL_ALIAS, value: 'X', source: SOURCE_HUMAN }, { id: 'a' }),
      evt('name_set', { channel: CHANNEL_ALIAS, value: 'Y', source: SOURCE_HUMAN }, { ts: TS_B, id: 'b' }),
      evt('name_set', { channel: CHANNEL_ALIAS, value: 'X', source: SOURCE_HUMAN }, { ts: TS_B, id: 'c' }),
    ];
    const { current, history } = splitChannelHistory(
      foldNameHistory(back).get(SID).get(CHANNEL_ALIAS),
    );
    assert.equal(current.value, 'X');
    assert.deepEqual(history.map((h) => h.value), ['X', 'Y']);
  });

  it('drops a session whose record was pruned', () => {
    // `names <id>` must not keep answering for a record `find` says is gone.
    const withTombstone = [...events, evt('session_prune', {}, { ts: TS_B, id: 'z' })];
    assert.equal(foldNameHistory(withTombstone).has(SID), false);
  });

  it('can restrict the fold to one session', () => {
    const other = evt('name_set', { channel: CHANNEL_ALIAS, value: 'B', source: SOURCE_HUMAN },
      { stableId: 'sess_other', id: 'o' });
    const hist = foldNameHistory([...events, other], { stableId: SID });
    assert.equal(hist.has(SID), true);
    assert.equal(hist.has('sess_other'), false);
  });

  it('tolerates junk rows without throwing', () => {
    assert.equal(foldNameHistory([null, 42, {}, { op: 'name_set' }]).size, 0);
    assert.equal(foldNameHistory('not an array').size, 0);
  });
});

describe('names.mjs — sortChannels', () => {
  it('puts known channels in registry order and unknown ones after, alphabetically', () => {
    // Unknown channels are SORTED, never dropped — the display must show a
    // name it does not recognise rather than hide it.
    assert.deepEqual(
      sortChannels(['zzz_future', CHANNEL_CC_AI_TITLE, 'aaa_future', CHANNEL_ALIAS, CHANNEL_AGENT_NAME]),
      [CHANNEL_ALIAS, CHANNEL_CC_AI_TITLE, CHANNEL_AGENT_NAME, 'aaa_future', 'zzz_future'],
    );
  });
});

// ---------------------------------------------------------------------------
// Review fixes: idempotency, sanitisation, timestamp typing, bounds.
// ---------------------------------------------------------------------------

describe('names.mjs — a naming that changes nothing IS nothing', () => {
  it('applyNameToSession leaves the record byte-identical and answers false', () => {
    const session = { names: [] };
    const change = { channel: CHANNEL_ALIAS, value: 'pinned', source: SOURCE_HUMAN, set_at: TS_A };
    assert.equal(applyNameToSession(session, change), true);
    const snapshot = JSON.parse(JSON.stringify(session.names));

    // Same naming, later timestamp — a second `alias <id> "pinned"`, or the
    // same event reaching the reducer twice off a cold cache.
    assert.equal(
      applyNameToSession(session, { ...change, set_at: TS_B }),
      false,
      'nothing changed, so the reducer must say so',
    );
    assert.deepEqual(session.names, snapshot);
    assert.equal(session.names[0].set_count, 1);
    assert.equal(session.names[0].set_at, TS_A, 'set_at marks the real set, not the re-assertion');
  });

  it('still counts a real rename, and a rename back', () => {
    const session = { names: [] };
    for (const value of ['A', 'B', 'A']) {
      applyNameToSession(session, { channel: CHANNEL_ALIAS, value, source: SOURCE_HUMAN, set_at: TS_A });
    }
    assert.equal(findNameEntry(session, CHANNEL_ALIAS).set_count, 3);
    assert.equal(findNameEntry(session, CHANNEL_ALIAS).value, 'A');
  });

  it('counts a clear, and counts naming it again after a clear', () => {
    const session = { names: [] };
    applyNameToSession(session, { channel: CHANNEL_ALIAS, value: 'x', source: SOURCE_HUMAN, set_at: TS_A });
    applyNameToSession(session, { channel: CHANNEL_ALIAS, value: null, source: SOURCE_HUMAN, set_at: TS_B });
    // Clearing twice is still one clear.
    applyNameToSession(session, { channel: CHANNEL_ALIAS, value: null, source: SOURCE_HUMAN, set_at: TS_B });
    assert.equal(findNameEntry(session, CHANNEL_ALIAS).set_count, 2);
    applyNameToSession(session, { channel: CHANNEL_ALIAS, value: 'x', source: SOURCE_HUMAN, set_at: TS_B });
    assert.equal(findNameEntry(session, CHANNEL_ALIAS).set_count, 3);
  });

  it('treats a different author as a different fact', () => {
    const session = { names: [] };
    applyNameToSession(session, { channel: 'x_ch', value: 'same', source: SOURCE_HARVEST, set_at: TS_A });
    assert.equal(
      applyNameToSession(session, { channel: 'x_ch', value: 'same', source: SOURCE_HUMAN, set_at: TS_B }),
      true,
    );
    assert.equal(findNameEntry(session, 'x_ch').set_count, 2);
    assert.equal(findNameEntry(session, 'x_ch').source, SOURCE_HUMAN);
  });

  it('foldNameHistory drops the repeat, so nothing current is also reported historical', () => {
    // The user-visible failure: `alias <id> "X"` run twice made `names` say
    // "1 superseded" and list the live value under both current and history.
    const dup = [
      evt('alias_set', { alias: 'X' }, { id: '1' }),
      evt('alias_set', { alias: 'X' }, { ts: TS_B, id: '2' }),
    ];
    const entries = foldNameHistory(dup).get(SID).get(CHANNEL_ALIAS);
    assert.equal(entries.length, 1);
    assert.deepEqual(splitChannelHistory(entries).history, []);
  });

  it('foldNameHistory still keeps a value that was dropped and restored', () => {
    // Only the IMMEDIATELY preceding entry is compared. Renamed-away-and-back
    // is two real renames and both have to survive.
    const back = [
      evt('name_set', { channel: CHANNEL_ALIAS, value: 'X', source: SOURCE_HUMAN }, { id: 'a' }),
      evt('name_set', { channel: CHANNEL_ALIAS, value: 'Y', source: SOURCE_HUMAN }, { ts: TS_B, id: 'b' }),
      evt('name_set', { channel: CHANNEL_ALIAS, value: 'X', source: SOURCE_HUMAN }, { ts: TS_B, id: 'c' }),
    ];
    assert.equal(foldNameHistory(back).get(SID).get(CHANNEL_ALIAS).length, 3);
  });

  it('agrees with the projection: same log, same set_count either way', () => {
    // The history reader and the reducer must not disagree, or `names` shows
    // a superseded value that the projection says is still current.
    const log = [
      evt('ai_title_seen', { ai_title: 'one', observed_at: TS_A }, { id: '1' }),
      evt('ai_title_seen', { ai_title: 'one', observed_at: TS_B }, { ts: TS_B, id: '2' }),
      evt('ai_title_seen', { ai_title: 'two', observed_at: TS_B }, { ts: TS_B, id: '3' }),
    ];
    const session = { names: [] };
    for (const e of log) applyNameToSession(session, nameChangeFromEvent(e));
    assert.equal(
      findNameEntry(session, CHANNEL_CC_AI_TITLE).set_count,
      foldNameHistory(log).get(SID).get(CHANNEL_CC_AI_TITLE).length,
    );
  });
});

describe('names.mjs — values are safe to print', () => {
  it('isValidNameValue refuses anything the sanitiser would rewrite', () => {
    assert.equal(isValidNameValue('ordinary name'), true);
    assert.equal(isValidNameValue(null), true);
    assert.equal(isValidNameValue('\x1b[31mred'), false, 'ANSI escape');
    assert.equal(isValidNameValue('two\nlines'), false, 'newline');
    assert.equal(isValidNameValue('nul\x00byte'), false, 'control byte');
    assert.equal(isValidNameValue('  padded'), false, 'untrimmed is not canonical');
  });

  it('nameChangeFromEvent sanitises a value written by an older build', () => {
    // The log is append-only: rows written before the sanitiser existed still
    // have to be safe by the time they reach a terminal.
    const change = nameChangeFromEvent(evt('name_set', {
      channel: CHANNEL_CC_CUSTOM_TITLE, value: '\x1b[2Kredesign\nBM', source: SOURCE_HUMAN,
    }));
    assert.equal(change.value, 'redesign BM');
  });

  it('nameSetPayload sanitises so the log never holds the raw bytes', () => {
    const payload = nameSetPayload({
      channel: CHANNEL_CC_CUSTOM_TITLE, value: 'a\x1b[0mb', source: SOURCE_HUMAN,
    });
    assert.equal(payload.value, 'ab');
  });

  it('a value that is nothing but escapes becomes a clear, not a stored blank', () => {
    // Empty string is not a name. Reporting it as `null` keeps the one
    // distinction the model cares about — cleared vs never named — intact.
    assert.equal(nameSetPayload({ channel: CHANNEL_ALIAS, value: '\x1b[2K' }).value, null);
  });
});

describe('names.mjs — set_at is a timestamp, not any string', () => {
  it('isIso8601 accepts what the writers emit and refuses the rest', () => {
    assert.equal(isIso8601('2026-08-19T01:02:03.000Z'), true);
    assert.equal(isIso8601('2026-08-19T01:02:03+02:00'), true);
    assert.equal(isIso8601('not-a-date'), false);
    assert.equal(isIso8601('2026-13-01T00:00:00Z'), false, 'right shape, not a real instant');
    assert.equal(isIso8601(''), false);
    assert.equal(isIso8601(null), false);
  });

  it('a junk observed_at falls back to the event ts instead of poisoning set_at', () => {
    // Dropping the whole name over a bad timestamp would lose more than it
    // protects; carrying "not-a-date" into a field typed Iso8601 lies to
    // every consumer that sorts or renders it.
    const change = nameChangeFromEvent(evt('name_set', {
      channel: CHANNEL_ALIAS, value: 'v', source: SOURCE_HUMAN, observed_at: 'not-a-date',
    }));
    assert.equal(change.value, 'v');
    assert.equal(change.set_at, TS_A);
  });

  it('a junk event ts leaves set_at null rather than a fake instant', () => {
    const change = nameChangeFromEvent({
      ts: 'whenever', event_id: 'evt_x', op: 'alias_set', stable_id: SID, payload: { alias: 'v' },
    });
    assert.equal(change.set_at, null);
  });

  it('nameSetPayload omits an unparseable observedAt', () => {
    const payload = nameSetPayload({ channel: CHANNEL_ALIAS, value: 'v', observedAt: 'not-a-date' });
    assert.equal('observed_at' in payload, false);
    assert.equal(nameSetPayload({ channel: CHANNEL_ALIAS, value: 'v', observedAt: TS_B }).observed_at, TS_B);
  });
});

describe('names.mjs — observed_from is bounded like everything else', () => {
  it('drops provenance that would blow the event budget, keeping the name', () => {
    // An event over MAX_EVENT_BYTES is refused outright, and the refusal
    // never mentions that a name was lost. The name is the payload; the path
    // is the footnote, so the footnote is what gets dropped.
    const huge = '/t/' + 'x'.repeat(MAX_OBSERVED_FROM_LEN);
    const payload = nameSetPayload({ channel: CHANNEL_ALIAS, value: 'kept', observedFrom: huge });
    assert.equal(payload.value, 'kept');
    assert.equal('observed_from' in payload, false);
    assert.equal(normalizeObservedFrom(huge), null);
    assert.equal(normalizeObservedFrom('/t/a.jsonl'), '/t/a.jsonl');
  });

  it('sanitises provenance too — it is rendered, so it is untrusted', () => {
    assert.equal(normalizeObservedFrom('/t/\x1b[31ma.jsonl'), '/t/a.jsonl');
  });
});

describe('names.mjs — hasAnyName', () => {
  it('sees a name on ANY channel, including one this build never heard of', () => {
    // Channel-agnostic on purpose: prune consumes this, and an enumerated
    // check would go one release stale behind every new namer — which means
    // deleting a record whose only name came through a channel it did not
    // recognise.
    assert.equal(hasAnyName({ names: [{ channel: 'dru_cli_label', value: 'x' }] }), true);
    assert.equal(hasAnyName({ names: [] }), false);
    assert.equal(hasAnyName({}), false);
    assert.equal(hasAnyName(null), false);
  });

  it('counts a cleared entry — somebody named it and then unnamed it', () => {
    assert.equal(hasAnyName({ names: [{ channel: CHANNEL_ALIAS, value: null }] }), true);
  });
});
