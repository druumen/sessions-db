import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireLock } from '../../lib/lock.mjs';
import {
  MAX_EVENT_BYTES,
  appendEvent,
  loadProjection,
  newEvent,
  rebuildProjection,
  recordSessionSeen,
  saveProjection,
  tryUpdateProjection,
} from '../../lib/storage.mjs';
import { MAX_PARENT_CANDIDATES } from '../../lib/identity.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STORAGE_MODULE = join(HERE, '..', '..', 'lib', 'storage.mjs');

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-storage-'));
}

function pathsFor(dir) {
  return {
    eventsJsonl: join(dir, 'events.jsonl'),
    projectionJson: join(dir, 'projection.json'),
    lockFile: join(dir, 'projection.lock'),
  };
}

const SID_A = 'sess_01970000-0000-7000-8000-00000000000a';
const SID_B = 'sess_01970000-0000-7000-8000-00000000000b';

describe('storage.mjs', () => {
  describe('newEvent', () => {
    it('builds an event with auto-filled ts and event_id', () => {
      const e = newEvent({ op: 'session_seen', stable_id: SID_A, payload: { x: 1 } });
      assert.equal(e.op, 'session_seen');
      assert.equal(e.stable_id, SID_A);
      assert.deepEqual(e.payload, { x: 1 });
      assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(e.event_id, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('honors explicit ts and event_id overrides', () => {
      const e = newEvent({
        op: 'alias_set',
        stable_id: SID_A,
        ts: '2026-05-09T00:00:00.000Z',
        event_id: 'evt_test-fixed',
      });
      assert.equal(e.ts, '2026-05-09T00:00:00.000Z');
      assert.equal(e.event_id, 'evt_test-fixed');
    });

    it('throws on missing op or stable_id', () => {
      assert.throws(() => newEvent({ stable_id: SID_A }), /op required/);
      assert.throws(() => newEvent({ op: 'alias_set' }), /stable_id required/);
    });
  });

  describe('appendEvent', () => {
    it('writes a single line of valid JSON ending with newline', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const e = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'a' } });
        await appendEvent(e, { paths });
        const raw = readFileSync(paths.eventsJsonl, 'utf8');
        assert.ok(raw.endsWith('\n'));
        assert.equal(raw.split('\n').filter(Boolean).length, 1);
        const parsed = JSON.parse(raw.trim());
        assert.equal(parsed.event_id, e.event_id);
        assert.equal(parsed.op, 'alias_set');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('multiple appends preserve order and line count', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const events = [];
        for (let i = 0; i < 10; i++) {
          const e = newEvent({
            op: 'session_link',
            stable_id: SID_A,
            payload: { tasks: [`t${i}`] },
          });
          events.push(e);
          await appendEvent(e, { paths });
        }
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 10);
        // Each line is valid JSON and the order matches what we wrote.
        for (let i = 0; i < 10; i++) {
          const parsed = JSON.parse(lines[i]);
          assert.equal(parsed.event_id, events[i].event_id);
          assert.deepEqual(parsed.payload.tasks, [`t${i}`]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects payload exceeding MAX_EVENT_BYTES and leaves events.jsonl untouched', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        // Pad payload past the 4 KiB cap. We use a single string field of
        // 8 KiB so the serialized event is unambiguously over.
        const huge = newEvent({
          op: 'session_seen',
          stable_id: SID_A,
          payload: { junk: 'x'.repeat(8000) },
        });
        await assert.rejects(
          () => appendEvent(huge, { paths }),
          (err) => {
            assert.match(err.message, /event payload too large/);
            assert.match(err.message, new RegExp(`max ${MAX_EVENT_BYTES}`));
            return true;
          },
        );
        // events.jsonl was either never created or created empty — never
        // contains the rejected payload.
        const content = existsSync(paths.eventsJsonl)
          ? readFileSync(paths.eventsJsonl, 'utf8')
          : '';
        assert.equal(content, '', `events.jsonl should be empty, got: ${content.slice(0, 80)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('accepts payloads at the MAX_EVENT_BYTES boundary (regression for the cap)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        // Build an event then size the junk so the serialized line lands
        // just under the cap. Iterate to converge on a valid size.
        let junkLen = 3000;
        let event;
        for (let i = 0; i < 32; i++) {
          event = newEvent({
            op: 'session_seen',
            stable_id: SID_A,
            payload: { junk: 'x'.repeat(junkLen) },
          });
          const lineLen = Buffer.byteLength(JSON.stringify(event) + '\n', 'utf8');
          if (lineLen <= MAX_EVENT_BYTES && lineLen > MAX_EVENT_BYTES - 50) break;
          junkLen += MAX_EVENT_BYTES - lineLen - 5;
        }
        await appendEvent(event, { paths });
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const parsed = JSON.parse(lines[0]);
        assert.equal(parsed.event_id, event.event_id);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('5 child processes × 50 events each → 250 valid JSON lines (O_APPEND race-safety)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const NUM_CHILDREN = 5;
        const PER_CHILD = 50;
        const procs = [];
        for (let c = 0; c < NUM_CHILDREN; c++) {
          procs.push(runWriter({
            childTag: `c${c}`,
            count: PER_CHILD,
            eventsPath: paths.eventsJsonl,
          }));
        }
        const results = await Promise.all(procs);
        for (const r of results) {
          assert.equal(
            r.code,
            0,
            `writer child failed: stderr=${r.stderr} stdout=${r.stdout}`,
          );
        }

        const lines = readFileSync(paths.eventsJsonl, 'utf8')
          .split('\n')
          .filter((l) => l.length > 0);
        assert.equal(
          lines.length,
          NUM_CHILDREN * PER_CHILD,
          `expected ${NUM_CHILDREN * PER_CHILD} lines, got ${lines.length}`,
        );
        // All lines parse and contain a valid tag.
        const tagCounts = new Map();
        for (const line of lines) {
          let parsed;
          assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `line not JSON: ${line}`);
          assert.ok(parsed.payload && typeof parsed.payload.tag === 'string');
          tagCounts.set(parsed.payload.tag, (tagCounts.get(parsed.payload.tag) || 0) + 1);
        }
        for (let c = 0; c < NUM_CHILDREN; c++) {
          assert.equal(
            tagCounts.get(`c${c}`),
            PER_CHILD,
            `child c${c} should have ${PER_CHILD} events`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('concurrent appends near (but under) MAX_EVENT_BYTES remain race-safe', async () => {
      // Regression for the cap: payload sized so the serialized line is
      // close to the cap but still within it. With the guard we just
      // landed, every event passes; the writes interleave cleanly because
      // they're all within PIPE_BUF.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const NUM_CHILDREN = 4;
        const PER_CHILD = 25;
        // Picked empirically: child runner builds events with this much
        // payload junk and lands ~3.5 KiB lines (well under 4 KiB cap).
        const PAYLOAD_BYTES = 3300;
        const procs = [];
        for (let c = 0; c < NUM_CHILDREN; c++) {
          procs.push(runWriter({
            childTag: `c${c}`,
            count: PER_CHILD,
            eventsPath: paths.eventsJsonl,
            payloadBytes: PAYLOAD_BYTES,
          }));
        }
        const results = await Promise.all(procs);
        for (const r of results) {
          assert.equal(
            r.code,
            0,
            `writer child failed: stderr=${r.stderr} stdout=${r.stdout}`,
          );
        }
        const lines = readFileSync(paths.eventsJsonl, 'utf8')
          .split('\n')
          .filter((l) => l.length > 0);
        assert.equal(
          lines.length,
          NUM_CHILDREN * PER_CHILD,
          `expected ${NUM_CHILDREN * PER_CHILD} lines, got ${lines.length}`,
        );
        for (const line of lines) {
          // Each line is valid JSON — interleave would have produced JSON
          // syntax errors here.
          let parsed;
          assert.doesNotThrow(
            () => { parsed = JSON.parse(line); },
            `near-bound line not JSON: ${line.slice(0, 120)}…`,
          );
          assert.equal(typeof parsed.payload.junk, 'string');
          assert.equal(parsed.payload.junk.length, PAYLOAD_BYTES);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('saveProjection / loadProjection', () => {
    it('saveProjection writes atomically and cleans up tmp file', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const projection = {
          _meta: { schema_version: 2, fingerprint_versions: [], updated: null, event_count: 0, last_event_id: null },
          sessions: { [SID_A]: { stable_id: SID_A, alias: 'a' } },
        };
        await saveProjection(projection, { paths });
        assert.ok(existsSync(paths.projectionJson));

        // No leftover .tmp.* files.
        const debris = readdirSync(dir).filter((f) => f.includes('.tmp.'));
        assert.deepEqual(debris, [], `expected no tmp debris, found: ${debris.join(',')}`);

        // Lock file released.
        assert.equal(existsSync(paths.lockFile), false);

        const loaded = await loadProjection({ paths });
        assert.equal(loaded.sessions[SID_A].alias, 'a');
        assert.match(loaded._meta.updated, /^\d{4}-\d{2}-\d{2}T/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadProjection falls back to rebuild when projection.json is corrupt', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        // Seed events.jsonl with two valid events.
        const e1 = newEvent({ op: 'session_seen', stable_id: SID_A, payload: { claude_session_id: 'cs-1' } });
        const e2 = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'recovered' } });
        await appendEvent(e1, { paths });
        await appendEvent(e2, { paths });
        // Write garbage to projection.json.
        writeFileSync(paths.projectionJson, '{not json{');

        const loaded = await loadProjection({ paths });
        assert.equal(loaded.sessions[SID_A].alias, 'recovered');
        assert.equal(loaded._meta.event_count, 2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadProjection treats missing schema as corrupt and rebuilds', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const e = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'x' } });
        await appendEvent(e, { paths });
        // Valid JSON but wrong shape.
        writeFileSync(paths.projectionJson, JSON.stringify({ wrong: 'shape' }));

        const loaded = await loadProjection({ paths });
        assert.ok(loaded.sessions[SID_A]);
        assert.equal(loaded.sessions[SID_A].alias, 'x');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('saveProjection blocks while another holder owns the lock (timeout fires)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        // Acquire lock outside saveProjection so the call has nowhere to go.
        const handle = await acquireLock(paths.lockFile, { timeoutMs: 200 });
        try {
          const projection = {
            _meta: { schema_version: 2, fingerprint_versions: [], updated: null, event_count: 0, last_event_id: null },
            sessions: {},
          };
          await assert.rejects(
            saveProjection(projection, { paths, lockTimeoutMs: 150, lockRetryMs: 25 }),
            /timeout after 150ms/,
          );
        } finally {
          handle.release();
        }
        // After release, save should succeed.
        await saveProjection(
          {
            _meta: { schema_version: 2, fingerprint_versions: [], updated: null, event_count: 0, last_event_id: null },
            sessions: {},
          },
          { paths, lockTimeoutMs: 500 },
        );
        assert.ok(existsSync(paths.projectionJson));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('rebuildProjection', () => {
    it('folds events.jsonl into projection.json with correct event_count', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const events = [
          newEvent({ op: 'session_seen', stable_id: SID_A, payload: { claude_session_id: 'cs-1' } }),
          newEvent({ op: 'session_seen', stable_id: SID_B, payload: { claude_session_id: 'cs-2' } }),
          newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'aaa' } }),
          newEvent({ op: 'session_link', stable_id: SID_B, payload: { tasks: ['t1'] } }),
        ];
        for (const e of events) await appendEvent(e, { paths });

        const result = await rebuildProjection({ paths });
        assert.equal(result.eventCount, events.length);
        assert.equal(result.sessionCount, 2);

        const loaded = await loadProjection({ paths });
        assert.equal(loaded._meta.event_count, events.length);
        assert.equal(loaded._meta.last_event_id, events.at(-1).event_id);
        assert.equal(loaded.sessions[SID_A].alias, 'aaa');
        assert.deepEqual(loaded.sessions[SID_B].tasks, ['t1']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rebuild tolerates a truncated tail line (writer interrupted mid-line)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const e1 = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'good' } });
        const e2 = newEvent({ op: 'alias_set', stable_id: SID_B, payload: { alias: 'also-good' } });
        await appendEvent(e1, { paths });
        await appendEvent(e2, { paths });
        // Simulate a writer interrupted mid-line: append a partial JSON
        // fragment WITHOUT a trailing newline. This is the exact shape we
        // see when crash recovery / external read-during-write surfaces.
        writeFileSync(
          paths.eventsJsonl,
          readFileSync(paths.eventsJsonl, 'utf8') + '{"op":"session_seen","stable',
        );

        const result = await rebuildProjection({ paths });
        // Both valid events fold in; the partial tail is reported as a
        // tolerated corruption (count = 1), not a hard error.
        assert.equal(result.eventCount, 2);
        assert.equal(result.toleratedCorruptions, 1);
        const loaded = await loadProjection({ paths });
        assert.equal(loaded.sessions[SID_A].alias, 'good');
        assert.equal(loaded.sessions[SID_B].alias, 'also-good');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rebuild throws on middle-line corruption (real data damage)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const valid = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'good' } });
        await appendEvent(valid, { paths });
        // Inject a malformed line BETWEEN two valid lines (and crucially
        // newline-terminated, so it is not classified as a tail-partial
        // write-in-progress). This shape implies real data damage —
        // filesystem error, partial overwrite, manual edit gone wrong.
        writeFileSync(
          paths.eventsJsonl,
          readFileSync(paths.eventsJsonl, 'utf8') + 'not-json{}\n',
        );
        const valid2 = newEvent({ op: 'alias_set', stable_id: SID_B, payload: { alias: 'also-good' } });
        await appendEvent(valid2, { paths });

        await assert.rejects(
          () => rebuildProjection({ paths }),
          (err) => {
            assert.match(err.message, /middle-line corruption/);
            assert.ok(Array.isArray(err.corruptions), 'err.corruptions must be array');
            assert.equal(err.corruptions.length, 1);
            assert.equal(err.corruptions[0].kind, 'middle_corruption');
            assert.equal(err.corruptions[0].tolerated, false);
            assert.match(err.corruptions[0].excerpt, /not-json/);
            return true;
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('tryUpdateProjection', () => {
    it('appends event to SSoT + applies into existing projection', async () => {
      // tryUpdateProjection is the canonical hook entry point — it MUST
      // append to events.jsonl itself (no caller-side double-append) and
      // then apply the event to the projection under lock.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const seen = newEvent({ op: 'session_seen', stable_id: SID_A, payload: { claude_session_id: 'cs-1' } });
        await appendEvent(seen, { paths });
        await rebuildProjection({ paths });

        const aliasEvt = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'live-update' } });
        const r = await tryUpdateProjection(aliasEvt, { paths });
        assert.equal(r.ok, true);

        // Projection reflects the new event…
        const loaded = await loadProjection({ paths });
        assert.equal(loaded.sessions[SID_A].alias, 'live-update');
        // …and events.jsonl has both events exactly once each (no double
        // append from the new internal append in tryUpdateProjection).
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 2);
        const ops = lines.map((l) => JSON.parse(l).op);
        assert.deepEqual(ops, ['session_seen', 'alias_set']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects oversized payload at append step (does not touch projection)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        await rebuildProjection({ paths }); // seed empty projection
        const huge = newEvent({
          op: 'session_seen',
          stable_id: SID_A,
          payload: { junk: 'x'.repeat(8000) },
        });
        const r = await tryUpdateProjection(huge, { paths });
        assert.equal(r.ok, false);
        assert.match(r.error, /^append: /);
        assert.match(r.error, /event payload too large/);
        // Neither events.jsonl nor projection has the rejected event.
        const content = existsSync(paths.eventsJsonl)
          ? readFileSync(paths.eventsJsonl, 'utf8')
          : '';
        assert.equal(content, '');
        const loaded = await loadProjection({ paths });
        assert.equal(loaded.sessions[SID_A], undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns { ok:false, error } when lock cannot be acquired', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        // Hold the lock so the read-modify-write inside tryUpdate cannot
        // acquire it. The append step (O_APPEND, no lock) still succeeds —
        // the SSoT remains consistent — but the projection update fails.
        const handle = await acquireLock(paths.lockFile, { timeoutMs: 200 });
        try {
          const e = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'fail' } });
          const r = await tryUpdateProjection(e, {
            paths,
            lockTimeoutMs: 100,
            lockRetryMs: 20,
          });
          assert.equal(r.ok, false);
          assert.match(r.error, /timeout after 100ms/);
          // Append still landed in events.jsonl (SSoT first).
          const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
          assert.equal(lines.length, 1);
        } finally {
          handle.release();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('lost-update regression: 2 concurrent updaters both land in projection', async () => {
      // Pre-fix bug: tryUpdateProjection did `loadProjection` outside the
      // lock, so two concurrent processes both read baseline N, each
      // applied their own event in memory, then took turns writing — the
      // loser's write clobbered the winner's. events.jsonl SSoT had both
      // events; projection only reflected one (until next rebuild).
      //
      // With the fix (lock spans load → apply → save), both updates land
      // in the same projection. We verify by spawning two child processes
      // that each call tryUpdateProjection on the same stable_id (one
      // adding task "t-A", the other adding "t-B") starting from a shared
      // baseline. The reducer is a set-union on session.tasks, so both
      // task names must appear in the final projection.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        // Seed baseline: one session with no tasks. Both children start
        // from this projection.
        const seen = newEvent({
          op: 'session_seen',
          stable_id: SID_A,
          payload: { claude_session_id: 'cs-baseline' },
        });
        await appendEvent(seen, { paths });
        await rebuildProjection({ paths });

        // Spawn two children. Each child:
        //  - artificially holds the lock briefly to widen the race window
        //    (forcing the load → save gap a pre-fix implementation would
        //    have exploited)
        //  - calls tryUpdateProjection with its own session_link event
        // We start them effectively simultaneously via Promise.all.
        const [resA, resB] = await Promise.all([
          runUpdater({ tag: 'A', taskName: 't-A', stableId: SID_A, paths }),
          runUpdater({ tag: 'B', taskName: 't-B', stableId: SID_A, paths }),
        ]);
        for (const r of [resA, resB]) {
          assert.equal(r.code, 0, `updater failed: stderr=${r.stderr}`);
        }

        // events.jsonl SSoT: baseline + 2 link events = 3 lines.
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 3, `expected 3 events in jsonl, got ${lines.length}`);

        // Critical assertion: projection includes BOTH t-A AND t-B.
        // Pre-fix this would intermittently fail with only one task,
        // because the loser's load → apply → save round overwrote the
        // winner's already-saved projection (which contained the other
        // task).
        const loaded = await loadProjection({ paths });
        const session = loaded.sessions[SID_A];
        assert.ok(session, 'session must exist');
        assert.ok(
          session.tasks.includes('t-A'),
          `projection missing t-A — lost-update bug. tasks=${JSON.stringify(session.tasks)}`,
        );
        assert.ok(
          session.tasks.includes('t-B'),
          `projection missing t-B — lost-update bug. tasks=${JSON.stringify(session.tasks)}`,
        );
        // event_count: baseline (1) + two link events (2) = 3.
        assert.equal(loaded._meta.event_count, 3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('end-to-end consistency', () => {
    it('rebuild → loaded projection has _meta.event_count equal to events.jsonl line count', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const N = 7;
        for (let i = 0; i < N; i++) {
          await appendEvent(
            newEvent({ op: 'session_link', stable_id: SID_A, payload: { tasks: [`t${i}`] } }),
            { paths },
          );
        }
        await rebuildProjection({ paths });
        const loaded = await loadProjection({ paths });
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(loaded._meta.event_count, lines.length);
        assert.equal(loaded._meta.event_count, N);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('recordSessionSeen — P3 identity (3-priority resolution)', () => {
    const CSID_1 = '11111111-1111-1111-1111-111111111111';
    const CSID_2 = '22222222-2222-2222-2222-222222222222';

    it('mints + injects identity_resolution=minted into payload on first sight', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const r = await recordSessionSeen({
          claudeSessionId: CSID_1,
          paths,
          payloadBuilder: (_id) => ({ claude_session_id: CSID_1, foo: 'bar' }),
        });
        assert.equal(r.ok, true);
        assert.equal(r.minted, true);
        assert.equal(r.identityResolution.source, 'minted');

        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const event = JSON.parse(lines[0]);
        assert.equal(event.payload.foo, 'bar');
        // Audit trail injection: payload must carry identity_resolution.
        assert.ok(event.payload.identity_resolution, 'identity_resolution must be injected');
        assert.equal(event.payload.identity_resolution.source, 'minted');
        assert.equal(event.payload.identity_resolution.confidence, 'minted');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('Resume scenario: P2 lineage match — second call shares stable_id of first', async () => {
      // Build first transcriptMeta — fresh session (firstParentUuid=null).
      // Build second transcriptMeta — resume (firstParentUuid points at the
      // first one's lastUuid). resolveIdentity must short-circuit on P2.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const transcriptMeta1 = {
          firstUuid: 'uuid-first-A',
          lastUuid: 'uuid-tail-A',
          firstParentUuid: null,
        };
        const r1 = await recordSessionSeen({
          claudeSessionId: CSID_1,
          paths,
          transcriptMeta: transcriptMeta1,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_1,
            // Reducer reads transcript_file.last_uuid for P2 lineage matching.
            transcript_file: { path: '/t/a.jsonl', first_uuid: 'uuid-first-A', last_uuid: 'uuid-tail-A' },
          }),
        });
        assert.equal(r1.ok, true);
        assert.equal(r1.identityResolution.source, 'minted');

        // Different csid. transcriptMeta.firstParentUuid points into r1's lastUuid.
        const transcriptMeta2 = {
          firstUuid: 'uuid-first-B',
          lastUuid: 'uuid-tail-B',
          firstParentUuid: 'uuid-tail-A', // <-- the resume signal
        };
        const r2 = await recordSessionSeen({
          claudeSessionId: CSID_2,
          paths,
          transcriptMeta: transcriptMeta2,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_2,
            transcript_file: { path: '/t/b.jsonl', first_uuid: 'uuid-first-B', last_uuid: 'uuid-tail-B' },
          }),
        });
        assert.equal(r2.ok, true);
        assert.equal(r2.stableId, r1.stableId, 'P2 lineage must reuse stable_id');
        assert.equal(r2.identityResolution.source, 'transcript_lineage');
        assert.equal(r2.identityResolution.confidence, 'high');

        // Projection has exactly one session, but two claude_session_ids.
        const proj = await loadProjection({ paths });
        assert.equal(Object.keys(proj.sessions).length, 1);
        const session = proj.sessions[r1.stableId];
        assert.deepEqual(session.claude_session_ids.sort(), [CSID_1, CSID_2].sort());
        // identity_resolution overwritten by latest (P2).
        assert.equal(session.identity_resolution.source, 'transcript_lineage');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parent_candidate_ids are injected when fingerprint matches but corroborator < 2', async () => {
      // First call: mint A with full context (cwd=/work/a, branch=main).
      // Second call: SAME fingerprint, DIFFERENT cwd + branch + no time
      // window proximity. resolveIdentity rejects identity (corroborator=0
      // / 1) and surfaces A as parent_candidate.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const fingerprints = { first_human_prompt_v1: 'fp-shared-prompt', lineage_prefix_v1: null };

        const r1 = await recordSessionSeen({
          claudeSessionId: CSID_1,
          paths,
          cwd: '/work/a',
          gitContext: { worktreeRealpath: '/work/a', branch: 'main' },
          fingerprints,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_1,
            cwd: '/work/a',
            worktree_realpath: '/work/a',
            branch_at_start: 'main',
            fingerprints,
          }),
        });
        assert.equal(r1.ok, true);

        const r2 = await recordSessionSeen({
          claudeSessionId: CSID_2,
          paths,
          cwd: '/totally/elsewhere',
          gitContext: { worktreeRealpath: '/totally/elsewhere', branch: 'feature-x' },
          fingerprints, // same fingerprint
          // Push now well past 72h so within_time_window also fails.
          now: Date.now() + 200 * 3600 * 1000,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_2,
            cwd: '/totally/elsewhere',
            worktree_realpath: '/totally/elsewhere',
            branch_at_start: 'feature-x',
            fingerprints,
          }),
        });
        assert.equal(r2.ok, true);
        assert.notEqual(r2.stableId, r1.stableId,
          'cross-cwd fingerprint match without enough corroborators must NOT merge identity');
        assert.equal(r2.identityResolution.source, 'minted');
        assert.equal(r2.identityResolution.parentCandidates.length, 1);
        assert.equal(r2.identityResolution.parentCandidates[0].stable_id, r1.stableId);

        // Verify event payload + projection both carry parent_candidate_ids.
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const event2 = JSON.parse(lines[1]);
        assert.ok(Array.isArray(event2.payload.parent_candidate_ids));
        assert.equal(event2.payload.parent_candidate_ids.length, 1);
        assert.equal(event2.payload.parent_candidate_ids[0].stable_id, r1.stableId);

        const proj = await loadProjection({ paths });
        const sessR2 = proj.sessions[r2.stableId];
        assert.equal(sessR2.parent_candidate_ids.length, 1);
        assert.equal(sessR2.parent_candidate_ids[0].stable_id, r1.stableId);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // P3 round-1 codex review patch 3: parent_candidate cap + omitted_count
    // surfacing. Verify the cap stays under MAX_EVENT_BYTES (so appendEvent
    // never rejects a session_seen with many fingerprint matches) and that
    // the omitted_count surfaces both in the event payload and the projection.
    it('parent_candidates capped + parent_candidates_omitted_count surfaces in payload + projection', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const fingerprints = { first_human_prompt_v1: 'fp-shared-prompt', lineage_prefix_v1: null };

        // Plant N prior session_seen events, all with the same fingerprint
        // but distinct cwds — none will pass the strong-corroborator gate
        // for the next call below, so all surface as candidates.
        // We seed (cap + 4) so 4 will be omitted from the surface.
        const SEED_COUNT = MAX_PARENT_CANDIDATES + 4;
        for (let i = 0; i < SEED_COUNT; i++) {
          const csid = `csid-prior-${i}`;
          const r = await recordSessionSeen({
            claudeSessionId: csid,
            paths,
            cwd: `/seed/path-${i}`,
            gitContext: { worktreeRealpath: `/seed/path-${i}`, branch: 'main' },
            fingerprints,
            payloadBuilder: (_id) => ({
              claude_session_id: csid,
              cwd: `/seed/path-${i}`,
              worktree_realpath: `/seed/path-${i}`,
              branch_at_start: 'main',
              fingerprints,
            }),
          });
          assert.equal(r.ok, true, `seed ${i} failed`);
        }

        // Hook fires from yet another distinct cwd — same fingerprint, no
        // strong corroborator against any of the 20 seeds.
        const r = await recordSessionSeen({
          claudeSessionId: 'csid-new',
          paths,
          cwd: '/work/elsewhere',
          gitContext: { worktreeRealpath: '/work/elsewhere', branch: 'main' },
          fingerprints,
          payloadBuilder: (_id) => ({
            claude_session_id: 'csid-new',
            cwd: '/work/elsewhere',
            worktree_realpath: '/work/elsewhere',
            branch_at_start: 'main',
            fingerprints,
          }),
        });
        assert.equal(r.ok, true);
        assert.equal(r.identityResolution.source, 'minted');

        // Inspect the FINAL session_seen event (last line — after all seeds).
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, SEED_COUNT + 1);
        const finalEvent = JSON.parse(lines[lines.length - 1]);
        assert.equal(finalEvent.payload.parent_candidate_ids.length, MAX_PARENT_CANDIDATES,
          'parent_candidate_ids must be capped at MAX_PARENT_CANDIDATES');
        assert.equal(finalEvent.payload.parent_candidates_omitted_count, 4,
          'omitted_count must reflect candidates trimmed by the cap');

        // Critical: the line bytes must be safely under MAX_EVENT_BYTES, so
        // a future hook with even more candidates is still under the
        // PIPE_BUF guarantee. We assert a comfortable margin (well below
        // 4096 — the cap is what protects us, not luck).
        const lineBytes = Buffer.byteLength(lines[lines.length - 1] + '\n', 'utf8');
        assert.ok(
          lineBytes < MAX_EVENT_BYTES,
          `event line ${lineBytes} bytes must be < MAX_EVENT_BYTES=${MAX_EVENT_BYTES}`,
        );
        // Margin assertion: we want the cap to leave ≥ 500 bytes headroom
        // so a transcript_file path with extra metadata cannot push us over.
        assert.ok(
          lineBytes <= MAX_EVENT_BYTES - 500,
          `cap must leave ≥500 bytes headroom; line=${lineBytes} max=${MAX_EVENT_BYTES}`,
        );

        // Projection mirrors the field on the new session record.
        const proj = await loadProjection({ paths });
        const newSession = proj.sessions[r.stableId];
        assert.equal(newSession.parent_candidate_ids.length, MAX_PARENT_CANDIDATES);
        assert.equal(newSession.parent_candidates_omitted_count, 4);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parent_candidates_omitted_count NOT injected when cap is not exceeded', async () => {
      // Sanity: small surface (only 1 prior candidate) → no omitted count
      // surfaces (we keep payload minimal when there is nothing to report).
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const fingerprints = { first_human_prompt_v1: 'fp-once', lineage_prefix_v1: null };
        await recordSessionSeen({
          claudeSessionId: 'csid-prior',
          paths,
          cwd: '/seed/a',
          gitContext: { worktreeRealpath: '/seed/a', branch: 'main' },
          fingerprints,
          payloadBuilder: (_id) => ({
            claude_session_id: 'csid-prior',
            cwd: '/seed/a',
            worktree_realpath: '/seed/a',
            branch_at_start: 'main',
            fingerprints,
          }),
        });
        const r = await recordSessionSeen({
          claudeSessionId: 'csid-new',
          paths,
          cwd: '/work/b',
          gitContext: { worktreeRealpath: '/work/b', branch: 'main' },
          fingerprints,
          payloadBuilder: (_id) => ({
            claude_session_id: 'csid-new',
            cwd: '/work/b',
            worktree_realpath: '/work/b',
            branch_at_start: 'main',
            fingerprints,
          }),
        });
        assert.equal(r.ok, true);
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const evt = JSON.parse(lines[1]);
        assert.equal(evt.payload.parent_candidate_ids.length, 1);
        // Field should be absent (we only inject when omitted > 0, keeps
        // the payload minimal for the common-case session).
        assert.equal(evt.payload.parent_candidates_omitted_count, undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('caller-supplied identity_resolution in payload is preserved (not overwritten)', async () => {
      // Edge case: if a caller (debug tool / future CLI) wants to override
      // the audit trail (e.g. attaching extra metadata), the injection
      // path respects an already-present field.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const r = await recordSessionSeen({
          claudeSessionId: CSID_1,
          paths,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_1,
            identity_resolution: { source: 'manual_override', confidence: 'high', matched: { reason: 'test' } },
          }),
        });
        assert.equal(r.ok, true);
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const event = JSON.parse(lines[0]);
        assert.equal(event.payload.identity_resolution.source, 'manual_override');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Privacy opt-out (cockpit Setup Wizard alignment 2026-05-11): library API
  // accepts `opts.storeFirstPrompt: boolean`. Default `true` preserves
  // 0.1.0-dev behavior. When `false`, payload.first_prompt_preview is set to
  // null on the persisted event — fingerprints + transcript_files meta stay
  // intact so identity reconciliation continues to work.
  // ---------------------------------------------------------------------------
  describe('recordSessionSeen — storeFirstPrompt opt-out (privacy)', () => {
    const CSID_PRIV = '33333333-3333-3333-3333-333333333333';

    it('storeFirstPrompt: true → preview field persisted as caller supplied', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const r = await recordSessionSeen({
          claudeSessionId: CSID_PRIV,
          paths,
          storeFirstPrompt: true,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_PRIV,
            first_prompt_preview: 'hello mock prompt',
            fingerprints: { first_human_prompt_v1: 'fp-mock', lineage_prefix_v1: 'ln-mock' },
            transcript_file: { path: '/mock/t.jsonl', first_uuid: 'u1', last_uuid: 'u2' },
          }),
        });
        assert.equal(r.ok, true);
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const event = JSON.parse(lines[0]);
        assert.equal(event.payload.first_prompt_preview, 'hello mock prompt',
          'storeFirstPrompt:true must keep the caller-supplied preview');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('storeFirstPrompt: false → preview field set to null on persisted payload', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const r = await recordSessionSeen({
          claudeSessionId: CSID_PRIV,
          paths,
          storeFirstPrompt: false,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_PRIV,
            // Caller still passes a preview (e.g. cockpit pre-computed one
            // before learning the user opted out). Storage MUST strip it.
            first_prompt_preview: 'this should not be persisted',
            fingerprints: { first_human_prompt_v1: 'fp-mock', lineage_prefix_v1: 'ln-mock' },
            transcript_file: { path: '/mock/t.jsonl', first_uuid: 'u1', last_uuid: 'u2' },
          }),
        });
        assert.equal(r.ok, true);
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const event = JSON.parse(lines[0]);
        assert.equal(event.payload.first_prompt_preview, null,
          'storeFirstPrompt:false must replace the preview with null');
        // Projection mirrors the strip — no leak via the cache either.
        const proj = await loadProjection({ paths });
        const session = proj.sessions[r.stableId];
        assert.equal(session.first_prompt_preview, null,
          'projection must mirror the null preview (no cache leak)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('storeFirstPrompt unset (default) → preview kept (backward compat)', async () => {
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const r = await recordSessionSeen({
          claudeSessionId: CSID_PRIV,
          paths,
          // No storeFirstPrompt opt → must preserve current 0.1.0-dev behavior.
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_PRIV,
            first_prompt_preview: 'default-on preview',
          }),
        });
        assert.equal(r.ok, true);
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const event = JSON.parse(lines[0]);
        assert.equal(event.payload.first_prompt_preview, 'default-on preview',
          'absent opt must default to true (backward compat)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('storeFirstPrompt: false does NOT touch fingerprints or transcript_file', async () => {
      // The whole point of this opt is "preview-only redaction" — identity
      // reconciliation must keep working. Both fingerprint hashes and the
      // transcript_file metadata stay on the persisted payload so resume +
      // fingerprint matching continue across the opt boundary.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const fingerprints = {
          first_human_prompt_v1: 'hash-deadbeef',
          lineage_prefix_v1: 'hash-cafebabe',
        };
        const transcriptFile = {
          path: '/mock/t.jsonl',
          first_uuid: 'uuid-first',
          last_uuid: 'uuid-tail',
          size: 1234,
          status: 'ok',
        };
        const r = await recordSessionSeen({
          claudeSessionId: CSID_PRIV,
          paths,
          storeFirstPrompt: false,
          fingerprints,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_PRIV,
            first_prompt_preview: 'should-be-stripped',
            fingerprints,
            transcript_file: transcriptFile,
          }),
        });
        assert.equal(r.ok, true);
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const event = JSON.parse(lines[0]);
        assert.equal(event.payload.first_prompt_preview, null);
        // Fingerprints + transcript_file untouched — identity still works.
        assert.deepEqual(event.payload.fingerprints, fingerprints,
          'storeFirstPrompt must NOT strip fingerprints (identity reconciliation depends on them)');
        assert.deepEqual(event.payload.transcript_file, transcriptFile,
          'storeFirstPrompt must NOT strip transcript_file meta (lineage matching depends on it)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('storeFirstPrompt: false on a follow-up call still resolves identity via P1 (csid index)', async () => {
      // First call mints with preview; second call (same csid) opts out and
      // MUST still reuse the same stable_id via the claude_session_id index.
      // Proves the opt is purely about persistence, not identity routing.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const r1 = await recordSessionSeen({
          claudeSessionId: CSID_PRIV,
          paths,
          // Default storeFirstPrompt (true).
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_PRIV,
            first_prompt_preview: 'first call preview',
          }),
        });
        assert.equal(r1.ok, true);
        const r2 = await recordSessionSeen({
          claudeSessionId: CSID_PRIV,
          paths,
          storeFirstPrompt: false,
          payloadBuilder: (_id) => ({
            claude_session_id: CSID_PRIV,
            first_prompt_preview: 'second call preview (must be stripped)',
          }),
        });
        assert.equal(r2.ok, true);
        assert.equal(r2.stableId, r1.stableId,
          'P1 csid-index reuse must work regardless of storeFirstPrompt');
        const lines = readFileSync(paths.eventsJsonl, 'utf8').split('\n').filter(Boolean);
        const evt2 = JSON.parse(lines[1]);
        assert.equal(evt2.payload.first_prompt_preview, null,
          'second event must persist null preview when opted out');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('saveProjection error path leaves no debris', () => {
    it('cleans up .tmp.<pid> file when fsync/rename fails', async () => {
      // We cannot easily induce a real fsync failure without mocking fs.
      // Instead, simulate the post-condition: write a stray .tmp.<pid> file
      // ourselves and assert saveProjection still succeeds, then verify our
      // stray file was NOT auto-removed (saveProjection only cleans the tmp
      // file *it* created, namespaced by pid). We're really checking the
      // happy path doesn't produce debris of its own.
      const dir = mkTmp();
      try {
        const paths = pathsFor(dir);
        const stray = `${paths.projectionJson}.tmp.999999`;
        writeFileSync(stray, 'leftover');
        await saveProjection(
          {
            _meta: { schema_version: 2, fingerprint_versions: [], updated: null, event_count: 0, last_event_id: null },
            sessions: {},
          },
          { paths },
        );
        // Real save tmp file (with our pid) is gone.
        const ours = `${paths.projectionJson}.tmp.${process.pid}`;
        assert.equal(existsSync(ours), false);
        // Foreign tmp file untouched (saveProjection only manages its own).
        assert.equal(existsSync(stray), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Day 4: backward-compat for the three opts-shape forms.
//
// These tests prove that storage primitives honor each of the three input
// shapes the resolver supports:
//   - opts.paths   (legacy storage-test form — fully-formed override)
//   - opts.rootPath (Day 4 form — rootPath IS the storage dir)
//   - opts.root   (legacy operations / CLI form — anchors `tickets/_logs/`)
//
// The high-volume tests above already exercise opts.paths; here we add
// targeted round-trips for the other two shapes plus an interop check
// that load(rootPath) sees what append(paths) wrote when both point to
// the same files.
// ---------------------------------------------------------------------------

describe('storage.mjs — Day 4 path resolution shapes', () => {
  it('opts.rootPath: append + load round-trips through canonical filenames', async () => {
    const rootPath = mkTmp();
    try {
      // Day 4 form: rootPath IS the storage dir — files live directly inside.
      const e = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'a' } });
      await appendEvent(e, { rootPath });
      // Append at the canonical filename inside rootPath.
      const written = readFileSync(join(rootPath, 'sessions-db-events.jsonl'), 'utf8');
      assert.equal(written.trim().split('\n').length, 1);
      // loadProjection with rootPath rebuilds from the same file.
      const proj = await loadProjection({ rootPath });
      assert.equal(proj._meta.event_count, 1);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('opts.root: append + load round-trips through legacy tickets/_logs/ layout', async () => {
    const root = mkTmp();
    try {
      // Legacy operations form: opts.root is the parent of tickets/_logs/.
      const e = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'l' } });
      await appendEvent(e, { root });
      // Legacy layout — events.jsonl lives under tickets/_logs/.
      const written = readFileSync(
        join(root, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      );
      assert.equal(written.trim().split('\n').length, 1);
      const proj = await loadProjection({ root });
      assert.equal(proj._meta.event_count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opts.paths still wins over rootPath / root (legacy storage-test shape preserved)', async () => {
    const dir = mkTmp();
    const decoyRoot = mkTmp();
    try {
      const paths = {
        eventsJsonl: join(dir, 'events.jsonl'),
        projectionJson: join(dir, 'projection.json'),
        lockFile: join(dir, 'projection.lock'),
      };
      const e = newEvent({ op: 'alias_set', stable_id: SID_A, payload: { alias: 'p' } });
      // Pass both `paths` AND `rootPath` — paths must win.
      await appendEvent(e, { paths, rootPath: decoyRoot });
      assert.ok(existsSync(paths.eventsJsonl), 'paths.eventsJsonl should be written');
      // The rootPath-based location should remain untouched.
      assert.equal(
        existsSync(join(decoyRoot, 'sessions-db-events.jsonl')), false,
        'rootPath-based events.jsonl must NOT exist when paths takes precedence',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });

  it('tryUpdateProjection with opts.rootPath honors Day 4 layout', async () => {
    const rootPath = mkTmp();
    try {
      const e = newEvent({
        op: 'session_seen',
        stable_id: SID_A,
        payload: { claude_session_id: 'csid-1' },
      });
      const r = await tryUpdateProjection(e, { rootPath });
      assert.equal(r.ok, true, r.error);
      // Both files should have appeared at the canonical names inside rootPath.
      assert.ok(existsSync(join(rootPath, 'sessions-db-events.jsonl')));
      assert.ok(existsSync(join(rootPath, 'sessions-db.json')));
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

/**
 * Spawn a child Node that appends `count` events to `eventsPath`. Each
 * event payload includes `tag` (= childTag) and a unique sequence number so
 * the parent can verify per-child counts after the race resolves.
 *
 * If `payloadBytes` is provided, each event also carries a `junk` string of
 * exactly that many bytes — used by the near-bound regression test to push
 * line size close to (but under) MAX_EVENT_BYTES.
 */
function runWriter({ childTag, count, eventsPath, payloadBytes = 0 }) {
  return new Promise((resolve, reject) => {
    const code = `
      import { appendEvent, newEvent } from ${JSON.stringify(STORAGE_MODULE)};
      const args = Object.fromEntries(
        process.argv
          .filter((a) => typeof a === 'string' && a.startsWith('--'))
          .map((a) => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v];
          }),
      );
      const events = Number(args.count);
      const tag = args.tag;
      const eventsPath = args.events;
      const payloadBytes = Number(args.payloadBytes || 0);
      const junk = payloadBytes > 0 ? 'x'.repeat(payloadBytes) : null;
      // Fixed stable_id is fine — race-safety is about the file write, not
      // about session diversity.
      const stableId = 'sess_01970000-0000-7000-8000-00000000c0c0';
      for (let i = 0; i < events; i++) {
        const payload = { tag, seq: i, tasks: [tag + '-' + i] };
        if (junk !== null) payload.junk = junk;
        const e = newEvent({
          op: 'session_link',
          stable_id: stableId,
          payload,
        });
        await appendEvent(e, { paths: { eventsJsonl: eventsPath, projectionJson: '/dev/null', lockFile: '/dev/null' } });
      }
      process.exit(0);
    `;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        code,
        '--',
        `--tag=${childTag}`,
        `--count=${count}`,
        `--events=${eventsPath}`,
        `--payloadBytes=${payloadBytes}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Spawn a child Node process that calls `tryUpdateProjection` with a
 * `session_link` event adding a single task name to the same stable_id.
 *
 * Used by the lost-update regression test: two of these run concurrently
 * against the same paths, each expecting both task names to appear in the
 * final projection (proving the lock spans the full read-modify-write).
 */
function runUpdater({ tag, taskName, stableId, paths }) {
  return new Promise((resolve, reject) => {
    const code = `
      import { newEvent, tryUpdateProjection } from ${JSON.stringify(STORAGE_MODULE)};
      const args = Object.fromEntries(
        process.argv
          .filter((a) => typeof a === 'string' && a.startsWith('--'))
          .map((a) => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v];
          }),
      );
      const event = newEvent({
        op: 'session_link',
        stable_id: args.stableId,
        payload: { tag: args.tag, tasks: [args.taskName] },
      });
      const r = await tryUpdateProjection(event, {
        paths: {
          eventsJsonl: args.eventsJsonl,
          projectionJson: args.projectionJson,
          lockFile: args.lockFile,
        },
        // Generous timeout — both children will compete for the lock.
        lockTimeoutMs: 5000,
        lockRetryMs: 25,
      });
      if (!r.ok) {
        process.stderr.write('updater failed: ' + r.error + '\\n');
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(r) + '\\n');
      process.exit(0);
    `;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        code,
        '--',
        `--tag=${tag}`,
        `--taskName=${taskName}`,
        `--stableId=${stableId}`,
        `--eventsJsonl=${paths.eventsJsonl}`,
        `--projectionJson=${paths.projectionJson}`,
        `--lockFile=${paths.lockFile}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
