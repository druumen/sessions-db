/**
 * End-to-end tests for the name read paths, spawned as real child processes:
 *
 *   - `sessions-db names <id>`      — per-channel current value + history
 *   - `sessions-db search`          — current names are indexed by default
 *   - `sessions-db search --include-history` — former names are opt-in
 *
 * Spawning rather than calling `run()` in-process is deliberate for the same
 * reason integration.test.mjs does it: it exercises the dispatcher's COMMANDS
 * map and the real exit codes, which an in-process stub cannot observe.
 *
 * The scenario planted below is the one from the field: a session whose title
 * the model rewrote mid-conversation, so the name the user remembers is not
 * the name the session currently has.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'sessions-db.mjs');

const SID_RENAMED = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_STABLE = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_GHOST = 'sess_cccccccc-3333-7000-8000-000000000003';

const OLD_TITLE = 'Fix HTTP 400 error for oversized goal parameter';
const NEW_TITLE = 'Analyze Knowledge Spine, changes, and graph architecture';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-names-cli-'));
}

function runCLI(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI hung > 5000ms'));
    }, 5000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code,
      });
    });
  });
}

function ev(op, stableId, payload, ts) {
  return {
    ts,
    event_id: `evt_${op}-${stableId.slice(5, 13)}-${ts}`,
    op,
    stable_id: stableId,
    payload,
  };
}

/**
 * Plant a log with three sessions:
 *   RENAMED — model titled it OLD_TITLE, then renamed it to NEW_TITLE
 *   STABLE  — still holds OLD_TITLE (so the default search must find it)
 *   GHOST   — named, then pruned
 */
function plantWorkspace() {
  const root = mkTmp();
  const dir = join(root, 'tickets/_logs');
  mkdirSync(dir, { recursive: true });
  const events = [
    ev('session_seen', SID_RENAMED, {
      claude_session_id: '11111111-1111-4111-8111-111111111111',
      first_prompt_preview: 'why does the goal parameter blow up',
    }, '2026-06-01T10:00:00.000Z'),
    // Legacy op — the 406 rows on the reference database look exactly like this.
    ev('ai_title_seen', SID_RENAMED, {
      ai_title: OLD_TITLE,
      source_transcript: '/t/renamed.jsonl',
      observed_at: '2026-06-04T23:07:28.990Z',
    }, '2026-06-04T23:07:28.990Z'),
    ev('name_set', SID_RENAMED, {
      channel: 'cc_ai_title', value: NEW_TITLE, source: 'llm',
      observed_from: '/t/renamed.jsonl', observed_at: '2026-06-05T22:16:34.913Z',
    }, '2026-06-05T22:16:34.913Z'),
    ev('name_set', SID_RENAMED, {
      channel: 'cc_custom_title', value: 'spine work', source: 'human',
    }, '2026-06-06T09:00:00.000Z'),

    ev('session_seen', SID_STABLE, {
      claude_session_id: '22222222-2222-4222-8222-222222222222',
    }, '2026-06-02T10:00:00.000Z'),
    ev('ai_title_seen', SID_STABLE, {
      ai_title: OLD_TITLE, source_transcript: '/t/stable.jsonl',
      observed_at: '2026-06-02T10:05:00.000Z',
    }, '2026-06-02T10:05:00.000Z'),

    ev('session_seen', SID_GHOST, {
      claude_session_id: '33333333-3333-4333-8333-333333333333',
    }, '2026-06-03T10:00:00.000Z'),
    ev('name_set', SID_GHOST, {
      channel: 'cc_ai_title', value: 'a ghost that was named', source: 'llm',
    }, '2026-06-03T10:01:00.000Z'),
    ev('session_prune', SID_GHOST, { reason: 'never used' }, '2026-06-03T11:00:00.000Z'),
  ];
  writeFileSync(
    join(dir, 'sessions-db-events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return root;
}

describe('sessions-db names', () => {
  it('lists every channel with its current value and the full change history', async () => {
    const root = plantWorkspace();
    try {
      const r = await runCLI(['names', SID_RENAMED, '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      // Current values, one line per channel.
      assert.match(r.stdout, /cc_ai_title\s+llm\s+2026-06-05T22:16:34\.913Z\s+2\s+Analyze Knowledge Spine/);
      assert.match(r.stdout, /cc_custom_title\s+human/);
      // The superseded value is readable — this is the whole point of the
      // command: before it existed the data was in the log and unreachable.
      assert.match(r.stdout, /Fix HTTP 400 error for oversized goal parameter/);
      // ...and the display chain's answer, plus WHY.
      assert.match(r.stdout, /display: spine work\s+\[via cc_custom_title\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--json separates current values from the timeline and tags each entry', async () => {
    const root = plantWorkspace();
    try {
      const r = await runCLI(['names', SID_RENAMED, '--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.stable_id, SID_RENAMED);
      assert.equal(out.display_name, 'spine work');
      assert.equal(out.display_name_channel, 'cc_custom_title');

      const ai = out.channels.find((c) => c.channel === 'cc_ai_title');
      assert.equal(ai.value, NEW_TITLE);
      assert.equal(ai.set_count, 2);
      assert.equal(ai.history_count, 1);
      assert.equal(ai.source, 'llm');
      assert.equal(ai.observed_from, '/t/renamed.jsonl');

      // Newest first, and the legacy op is carried through so a reader can go
      // back to the exact row in events.jsonl.
      assert.deepEqual(out.history.map((h) => h.value), [
        'spine work', NEW_TITLE, OLD_TITLE,
      ]);
      assert.deepEqual(out.history.map((h) => h.kind), ['current', 'current', 'history']);
      assert.equal(out.history.at(-1).op, 'ai_title_seen');
      assert.equal(out.history.at(-1).set_at, '2026-06-04T23:07:28.990Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 1 for an unknown stable_id', async () => {
    const root = plantWorkspace();
    try {
      const r = await runCLI(['names', 'sess_no-such-0000-0000-0000-000000000000', '--root', root]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /stable_id not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to answer for a pruned session, matching find', async () => {
    // A tombstoned record must not still have a readable name, or `names`
    // would contradict every other read path about whether it exists.
    const root = plantWorkspace();
    try {
      const r = await runCLI(['names', SID_GHOST, '--root', root]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /stable_id not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sessions-db search — names', () => {
  it('finds a session by the title it currently shows (default path)', async () => {
    // The hole this closes: ai_title was the name the user actually sees in
    // Claude Code, and it was the one thing metadata search did not index.
    const root = plantWorkspace();
    try {
      const r = await runCLI(['search', OLD_TITLE, '--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.map((x) => x.stable_id), [SID_STABLE]);
      assert.deepEqual(out[0].matched_in, ['name:cc_ai_title']);
      assert.deepEqual(out[0].name_hits, [{
        channel: 'cc_ai_title',
        value: OLD_TITLE,
        set_at: '2026-06-02T10:05:00.000Z',
        source: 'llm',
        kind: 'current',
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT reach a former name without the flag', async () => {
    // Default stays projection-only. That is what keeps the default fast and
    // "why did this match?" answerable without reading the event log.
    const root = plantWorkspace();
    try {
      const r = await runCLI(['search', OLD_TITLE, '--root', root, '--json']);
      const ids = JSON.parse(r.stdout).map((x) => x.stable_id);
      assert.equal(ids.includes(SID_RENAMED), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--include-history finds the renamed session and says the hit is historical', async () => {
    const root = plantWorkspace();
    try {
      const r = await runCLI(['search', 'Fix HTTP 400', '--root', root, '--include-history', '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      const renamed = out.find((x) => x.stable_id === SID_RENAMED);
      assert.ok(renamed, 'the renamed session must be findable under its old name');
      assert.deepEqual(renamed.matched_in, ['name_history:cc_ai_title']);
      assert.deepEqual(renamed.name_hits, [{
        channel: 'cc_ai_title',
        value: OLD_TITLE,
        set_at: '2026-06-04T23:07:28.990Z',
        source: 'llm',
        kind: 'history',
      }]);
      // The session that still holds the name is reported as `current`, so the
      // two are distinguishable in one result set. Exactly one hit: a value
      // that is still current must NOT also be reported as history, or the
      // flag's whole point — telling "is called" from "was called" apart —
      // collapses.
      const stable = out.find((x) => x.stable_id === SID_STABLE);
      assert.deepEqual(stable.matched_in, ['name:cc_ai_title']);
      assert.equal(stable.name_hits.length, 1);
      assert.equal(stable.name_hits[0].kind, 'current');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('labels current vs historical in the human output too', async () => {
    const root = plantWorkspace();
    try {
      const r = await runCLI(['search', 'Fix HTTP 400', '--root', root, '--include-history']);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /name \[history\] cc_ai_title, set 2026-06-04T23:07:28\.990Z: Fix HTTP 400/);
      assert.match(r.stdout, /name \[current\] cc_ai_title/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never resurrects a pruned session through its name history', async () => {
    const root = plantWorkspace();
    try {
      const r = await runCLI(['search', 'a ghost that was named', '--root', root, '--include-history', '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sessions-db search — a projection cache written before names[]', () => {
  /**
   * Plant a 0.2.0-shaped cache: `ai_title` present, no `names`, no
   * `display_name`. This is what every existing installation has on disk until
   * something rebuilds it, so it is the shape the read paths must handle — not
   * an edge case.
   */
  function plantLegacyCache() {
    const root = mkTmp();
    const dir = join(root, 'tickets/_logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sessions-db.json'), JSON.stringify({
      _meta: {
        schema_version: 2,
        fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
        updated: '2026-06-01T00:00:00.000Z', event_count: 2, last_event_id: 'evt_x',
      },
      sessions: {
        [SID_STABLE]: {
          stable_id: SID_STABLE,
          alias: null,
          ai_title: OLD_TITLE,
          claude_session_ids: [], transcript_files: [],
          tasks: [], projects: [],
          activity_state: 'active', outcome: 'open',
          created_at: '2026-06-01T00:00:00.000Z',
          last_progress_at: '2026-06-02T00:00:00.000Z',
          first_prompt_preview: null,
        },
      },
    }));
    return root;
  }

  it('still finds it by title and reports a resolved display name', async () => {
    const root = plantLegacyCache();
    try {
      const r = await runCLI(['search', 'HTTP 400', '--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0].matched_in, ['name:cc_ai_title']);
      // Resolved, not read off the record: the field does not exist on this
      // cache, and returning null for every legacy row would be a regression
      // dressed up as a new feature.
      assert.equal(out[0].display_name, OLD_TITLE);
      assert.equal(out[0].display_name_channel, 'cc_ai_title');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
