import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEvent, emptyProjection, emptySession, rebuildFromEvents } from '../../lib/projection.mjs';
import {
  CHANNEL_AGENT_NAME,
  CHANNEL_ALIAS,
  CHANNEL_CC_AI_TITLE,
  CHANNEL_CC_CUSTOM_TITLE,
  CHANNEL_FIRST_PROMPT,
  SOURCE_HARVEST,
  SOURCE_HUMAN,
  SOURCE_LLM,
  findNameEntry,
} from '../../lib/names.mjs';
import { loadProjection, newEvent, saveProjection, tryUpdateProjection } from '../../lib/storage.mjs';

const TS_A = '2026-08-01T10:00:00.000Z';
const TS_B = '2026-08-02T10:00:00.000Z';
const TS_C = '2026-08-03T10:00:00.000Z';
const SID = 'sess_01970000-0000-7000-8000-000000000001';

function evt(op, ts, payload, idSuffix = 'a') {
  return { ts, event_id: `evt_test-${ts}-${idSuffix}`, op, stable_id: SID, payload: payload ?? {} };
}

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-names-'));
}

describe('projection.mjs — name model', () => {
  it('emptySession starts with an empty names list and no display name', () => {
    const s = emptySession(SID, TS_A);
    assert.deepEqual(s.names, []);
    assert.equal(s.display_name, null);
    assert.equal(s.display_name_channel, null);
  });

  describe('name_set reducer', () => {
    it('records the channel and mirrors the two legacy fields', () => {
      const p = emptyProjection();
      applyEvent(p, evt('name_set', TS_A, { channel: CHANNEL_ALIAS, value: 'mainline', source: SOURCE_HUMAN }));
      applyEvent(p, evt('name_set', TS_B, { channel: CHANNEL_CC_AI_TITLE, value: 'A title', source: SOURCE_LLM }, 'b'));
      const s = p.sessions[SID];
      assert.equal(s.alias, 'mainline', 'legacy mirror stays in step');
      assert.equal(s.ai_title, 'A title', 'legacy mirror stays in step');
      assert.deepEqual(s.names.map((n) => n.channel), [CHANNEL_ALIAS, CHANNEL_CC_AI_TITLE]);
      assert.equal(s.display_name, 'mainline');
      assert.equal(s.display_name_channel, CHANNEL_ALIAS);
    });

    it('records a channel with NO legacy mirror without inventing one', () => {
      const p = emptyProjection();
      applyEvent(p, evt('name_set', TS_A, {
        channel: CHANNEL_CC_CUSTOM_TITLE, value: 'redesign BM overview', source: SOURCE_HUMAN,
      }));
      const s = p.sessions[SID];
      assert.equal(findNameEntry(s, CHANNEL_CC_CUSTOM_TITLE).value, 'redesign BM overview');
      assert.equal(s.alias, null);
      assert.equal(s.ai_title, null);
      assert.equal(s.display_name_channel, CHANNEL_CC_CUSTOM_TITLE);
    });

    it('clears through to the mirror, keeping the entry as a null-valued record', () => {
      const p = emptyProjection();
      applyEvent(p, evt('name_set', TS_A, { channel: CHANNEL_ALIAS, value: 'gone-soon', source: SOURCE_HUMAN }));
      applyEvent(p, evt('name_set', TS_B, { channel: CHANNEL_ALIAS, value: null, source: SOURCE_HUMAN }, 'b'));
      const s = p.sessions[SID];
      assert.equal(s.alias, null);
      assert.equal(s.names.length, 1, 'the entry survives — a clear is not a delete');
      assert.equal(s.names[0].value, null);
      assert.equal(s.names[0].set_count, 2);
    });

    it('ignores a malformed name_set entirely', () => {
      const p = emptyProjection();
      applyEvent(p, evt('name_set', TS_A, { channel: 'bad channel', value: 'x', source: SOURCE_HUMAN }));
      assert.deepEqual(p.sessions[SID].names, []);
      assert.equal(p._meta.event_count, 1, 'still counted — the event happened');
    });
  });

  describe('legacy ops feed the same model', () => {
    it('alias_set writes the alias channel AND the historical field', () => {
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'from-old-cli' }));
      const s = p.sessions[SID];
      assert.equal(s.alias, 'from-old-cli');
      assert.deepEqual(
        s.names.map((n) => [n.channel, n.value, n.source]),
        [[CHANNEL_ALIAS, 'from-old-cli', SOURCE_HUMAN]],
      );
    });

    it('ai_title_seen becomes cc_ai_title history, provenance included', () => {
      // This is where the 406 rows already on disk turn into history for free.
      const p = emptyProjection();
      applyEvent(p, evt('ai_title_seen', TS_A, {
        ai_title: 'Fix HTTP 400 error for oversized goal parameter',
        source_transcript: '/t/a.jsonl',
        observed_at: TS_A,
      }));
      applyEvent(p, evt('ai_title_seen', TS_B, {
        ai_title: 'Analyze Knowledge Spine',
        source_transcript: '/t/a.jsonl',
        observed_at: TS_B,
      }, 'b'));
      const s = p.sessions[SID];
      assert.equal(s.ai_title, 'Analyze Knowledge Spine');
      const entry = findNameEntry(s, CHANNEL_CC_AI_TITLE);
      assert.equal(entry.value, 'Analyze Knowledge Spine');
      assert.equal(entry.source, SOURCE_LLM);
      assert.equal(entry.set_at, TS_B, 'observed_at preferred over the event ts');
      assert.equal(entry.observed_from, '/t/a.jsonl');
      assert.equal(entry.set_count, 2, 'both observations counted');
    });

    it('an empty alias_set payload changes nothing, as it always did', () => {
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'kept' }));
      applyEvent(p, evt('alias_set', TS_B, {}, 'b'));
      assert.equal(p.sessions[SID].alias, 'kept');
      assert.equal(findNameEntry(p.sessions[SID], CHANNEL_ALIAS).set_count, 1);
    });
  });

  describe('display_name is derived, never drifts', () => {
    it('falls back to first_prompt_preview and names that channel', () => {
      const p = emptyProjection();
      applyEvent(p, evt('session_progress', TS_A, {
        claude_session_id: '11111111-1111-4111-8111-111111111111',
        first_prompt_preview: 'how do I ship this',
      }));
      const s = p.sessions[SID];
      assert.equal(s.display_name, 'how do I ship this');
      assert.equal(s.display_name_channel, CHANNEL_FIRST_PROMPT);
    });

    it('recomputes when an unrelated op moves an input', () => {
      // display_name depends on inputs three different reducers can move. It
      // is refreshed centrally in applyEvent so it cannot go stale when a
      // reducer that has nothing to do with names latches the first prompt.
      const p = emptyProjection();
      applyEvent(p, evt('name_set', TS_A, { channel: CHANNEL_AGENT_NAME, value: 'a-badge', source: SOURCE_HARVEST }));
      assert.equal(p.sessions[SID].display_name, null, 'agent_name is not in the chain');
      applyEvent(p, evt('session_seen', TS_B, {
        claude_session_id: '11111111-1111-4111-8111-111111111111',
        first_prompt_preview: 'first thing asked',
      }, 'b'));
      assert.equal(p.sessions[SID].display_name, 'first thing asked');
      assert.equal(p.sessions[SID].display_name_channel, CHANNEL_FIRST_PROMPT);
    });

    it('an alias set long ago still outranks a fresh Claude Code rename', () => {
      // The accepted UX cost of alias-highest. The point of asserting it is
      // that display_name_channel makes the reason legible — a UI can say
      // "showing the alias" rather than looking broken.
      const p = emptyProjection();
      applyEvent(p, evt('alias_set', TS_A, { alias: 'old-alias' }));
      applyEvent(p, evt('name_set', TS_C, {
        channel: CHANNEL_CC_CUSTOM_TITLE, value: 'renamed just now', source: SOURCE_HUMAN,
      }, 'c'));
      assert.equal(p.sessions[SID].display_name, 'old-alias');
      assert.equal(p.sessions[SID].display_name_channel, CHANNEL_ALIAS);
    });

    it('is not written onto a record the same event deleted', () => {
      const p = emptyProjection();
      applyEvent(p, evt('name_set', TS_A, { channel: CHANNEL_ALIAS, value: 'x', source: SOURCE_HUMAN }));
      applyEvent(p, evt('session_prune', TS_B, { reason: 'ghost' }, 'b'));
      assert.equal(p.sessions[SID], undefined);
    });
  });

  describe('the projection stays flat (O(channels), not O(renames))', () => {
    it('200 renames across 3 channels leave 3 entries and no history', () => {
      const events = [];
      for (let i = 0; i < 200; i++) {
        const channel = [CHANNEL_ALIAS, CHANNEL_CC_AI_TITLE, CHANNEL_CC_CUSTOM_TITLE][i % 3];
        events.push(evt('name_set', TS_A, { channel, value: `name ${i}`, source: SOURCE_HARVEST }, `i${i}`));
      }
      const p = rebuildFromEvents(events);
      const s = p.sessions[SID];
      assert.equal(s.names.length, 3);
      // Structural, not cosmetic: no field anywhere under `names` may be an
      // array of past values. If history ever leaks into the projection this
      // is the assertion that catches it — the file is read whole on every
      // cockpit refresh.
      for (const entry of s.names) {
        for (const [key, value] of Object.entries(entry)) {
          assert.equal(Array.isArray(value), false, `names[].${key} must not be a list`);
        }
        assert.deepEqual(
          Object.keys(entry).sort(),
          ['channel', 'set_at', 'set_count', 'source', 'value'],
        );
      }
      // The only trace of the other 197 sets is a counter.
      assert.equal(s.names.reduce((n, e) => n + e.set_count, 0), 200);
      const serialized = JSON.stringify(s.names).length;
      assert.ok(serialized < 600, `names block should stay small, was ${serialized} bytes`);
    });
  });

  describe('forward compatibility: unknown channels survive a read/write cycle', () => {
    it('keeps unknown channel + unknown source through load → apply → save → load', async () => {
      // The failure this pins: a reader that filtered channels it did not
      // recognise would drop them on the next save. No error, no warning —
      // the loss only shows up when somebody looks for a name that is gone.
      const root = mkTmp();
      try {
        const opts = { rootPath: root };
        const p = emptyProjection();
        applyEvent(p, evt('name_set', TS_A, {
          channel: 'dru_cli_label', value: 'set by a newer build', source: 'plugin',
        }));
        applyEvent(p, evt('name_set', TS_B, {
          channel: CHANNEL_ALIAS, value: 'known', source: SOURCE_HUMAN,
        }, 'b'));
        await saveProjection(p, opts);

        // A later, unrelated write on the same session — the moment a naive
        // reader would rewrite the record without the fields it ignored.
        const later = newEvent({
          op: 'name_set',
          stable_id: SID,
          payload: { channel: CHANNEL_CC_AI_TITLE, value: 'harvested', source: SOURCE_LLM },
        });
        const res = await tryUpdateProjection(later, opts);
        assert.equal(res.ok, true, res.error);

        const reloaded = await loadProjection(opts);
        const names = reloaded.sessions[SID].names;
        const unknown = names.find((n) => n.channel === 'dru_cli_label');
        assert.ok(unknown, 'unknown channel must survive the round trip');
        assert.equal(unknown.value, 'set by a newer build');
        assert.equal(unknown.source, 'plugin', 'unknown source survives too');
        assert.equal(names.length, 3);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('a full rebuild from events also keeps them', async () => {
      const events = [
        evt('name_set', TS_A, { channel: 'mcp_title', value: 'from an MCP tool', source: 'mcp' }),
        evt('name_set', TS_B, { channel: CHANNEL_ALIAS, value: 'known', source: SOURCE_HUMAN }, 'b'),
      ];
      const s = rebuildFromEvents(events).sessions[SID];
      assert.deepEqual(
        s.names.map((n) => n.channel).sort(),
        [CHANNEL_ALIAS, 'mcp_title'],
      );
      // ...and an unknown channel never hijacks the display chain.
      assert.equal(s.display_name_channel, CHANNEL_ALIAS);
    });
  });

  describe('replay stability', () => {
    it('folding the same log twice yields the same names block', () => {
      const events = [
        evt('ai_title_seen', TS_A, { ai_title: 'one', observed_at: TS_A }),
        evt('name_set', TS_B, { channel: CHANNEL_CC_CUSTOM_TITLE, value: 'two', source: SOURCE_HUMAN }, 'b'),
        evt('alias_set', TS_C, { alias: 'three' }, 'c'),
      ];
      const once = rebuildFromEvents(events).sessions[SID];
      const twice = rebuildFromEvents([...events, ...events]).sessions[SID];
      assert.deepEqual(
        once.names.map((n) => ({ ...n, set_count: undefined })),
        twice.names.map((n) => ({ ...n, set_count: undefined })),
        'same values, same order',
      );
      assert.equal(once.display_name, twice.display_name);
      // set_count is the one field that legitimately differs: it counts
      // events, and replaying the log twice really is twice as many events.
      assert.equal(twice.names[0].set_count, once.names[0].set_count * 2);
    });
  });
});
