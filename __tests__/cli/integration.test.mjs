/**
 * Integration test — spawns scripts/sessions-db.mjs as a real child process
 * and walks the full lifecycle:
 *   1. Plant fake events.jsonl
 *   2. `rebuild` → projection materializes
 *   3. `find --json` → matches the planted sessions
 *   4. `alias` → set human alias, observable in next find
 *   5. `link --task` → tasks[] populated
 *   6. `link-parent` → parent_session_id wired
 *   7. `tree` → renders the hub-spoke chain
 *   8. `close --outcome done --reason "..."` → outcome flips
 *   9. `find --state active` → no longer returns the closed session (closed
 *      sessions still have activity_state=active until sweep runs; we test
 *      `--outcome done` filter instead which does flip)
 *
 * The point of doing this end-to-end is twofold:
 *   - Verify the dispatcher correctly routes to each handler module via real
 *     dynamic import (catches a missing default export or a typo'd
 *     COMMANDS map entry that unit tests don't exercise).
 *   - Verify exit codes propagate up through the OS shell layer — the
 *     in-process write-handler unit tests stub process.exit, but this test
 *     observes the actual child.exitCode the OS reports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'sessions-db.mjs');

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-cli-int-'));
}

/**
 * Run the CLI as a child process, capture stdout/stderr/exitCode.
 * Hard timeout 5s; longer than any single subcommand should ever take.
 */
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
      reject(new Error(`CLI hung > 5000ms`));
    }, 5000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code,
        signal,
      });
    });
  });
}

function plantEvents(root, events) {
  const dir = join(root, 'tickets/_logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sessions-db-events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function readEvents(root) {
  const p = join(root, 'tickets/_logs/sessions-db-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readProjection(root) {
  return JSON.parse(readFileSync(
    join(root, 'tickets/_logs/sessions-db.json'), 'utf8'));
}

function freshEvent(op, stableId, payload) {
  return {
    ts: new Date().toISOString(),
    event_id: `evt_${op}-${Math.random().toString(36).slice(2)}`,
    op,
    stable_id: stableId,
    payload: payload || {},
  };
}

describe('sessions-db CLI — full lifecycle integration (spawn)', () => {
  it('rebuild → find → alias → link → link-parent → tree → close → find', async () => {
    const root = mkTmp();
    try {
      // ── 1. plant: two sessions seen, no aliases / links / parent yet ──
      plantEvents(root, [
        freshEvent('session_seen', SID_A, {
          claude_session_id: 'csid-A',
          first_prompt_preview: 'hello A',
        }),
        freshEvent('session_seen', SID_B, {
          claude_session_id: 'csid-B',
          first_prompt_preview: 'hello B',
        }),
      ]);

      // ── 2. rebuild ──
      const rebuild = await runCLI(['rebuild', '--root', root, '--json']);
      assert.equal(rebuild.exitCode, 0, `rebuild stderr: ${rebuild.stderr}`);
      const rebuildOut = JSON.parse(rebuild.stdout);
      assert.equal(rebuildOut.ok, true);
      assert.equal(rebuildOut.sessionCount, 2);
      assert.equal(rebuildOut.eventCount, 2);

      // ── 3. find --json should return 2 sessions ──
      const find1 = await runCLI(['find', '--root', root, '--json']);
      assert.equal(find1.exitCode, 0);
      const find1Out = JSON.parse(find1.stdout);
      assert.equal(find1Out.length, 2);

      // ── 4. alias on SID_A ──
      const alias = await runCLI([
        'alias', SID_A, 'integration-test-A', '--root', root,
      ]);
      assert.equal(alias.exitCode, 0, `alias stderr: ${alias.stderr}`);
      assert.match(alias.stdout, /ok: alias_set/);

      // ── 5. link --task on SID_A ──
      const link = await runCLI([
        'link', SID_A,
        '--task', 'feat-integration-test.md',
        '--project', 'sessions-db',
        '--root', root,
      ]);
      assert.equal(link.exitCode, 0, `link stderr: ${link.stderr}`);

      // ── 6. link-parent: SID_B becomes child of SID_A ──
      const linkParent = await runCLI([
        'link-parent', SID_B, SID_A, '--root', root,
      ]);
      assert.equal(linkParent.exitCode, 0, `link-parent stderr: ${linkParent.stderr}`);

      // ── 7. tree --json from SID_A ──
      const tree = await runCLI(['tree', SID_A, '--root', root, '--json']);
      assert.equal(tree.exitCode, 0, `tree stderr: ${tree.stderr}`);
      const treeOut = JSON.parse(tree.stdout);
      assert.equal(treeOut.stable_id, SID_A);
      assert.equal(treeOut.alias, 'integration-test-A');
      assert.equal(treeOut.children.length, 1);
      assert.equal(treeOut.children[0].stable_id, SID_B);

      // ── 8. close SID_A ──
      const close = await runCLI([
        'close', SID_A, '--outcome', 'done', '--reason', 'integration-test', '--root', root,
      ]);
      assert.equal(close.exitCode, 0, `close stderr: ${close.stderr}`);

      // ── 9. find --outcome done returns SID_A only ──
      const find2 = await runCLI([
        'find', '--root', root, '--outcome', 'done', '--json',
      ]);
      assert.equal(find2.exitCode, 0);
      const find2Out = JSON.parse(find2.stdout);
      assert.equal(find2Out.length, 1);
      assert.equal(find2Out[0].stable_id, SID_A);
      assert.equal(find2Out[0].alias, 'integration-test-A');
      assert.equal(find2Out[0].outcome, 'done');
      assert.equal(find2Out[0].closed_reason, 'integration-test');
      assert.deepEqual(find2Out[0].tasks, ['feat-integration-test.md']);

      // ── 10. events.jsonl line count = 2 (planted) + 4 (alias/link/link-parent/close) = 6 ──
      const events = readEvents(root);
      assert.equal(events.length, 6, `expected 6 events, got ${events.length}`);
      const opCounts = events.reduce((m, e) => {
        m[e.op] = (m[e.op] || 0) + 1;
        return m;
      }, {});
      assert.equal(opCounts.session_seen, 2);
      assert.equal(opCounts.alias_set, 1);
      assert.equal(opCounts.session_link, 1);
      assert.equal(opCounts.parent_set, 1);
      assert.equal(opCounts.close, 1);

      // ── 11. projection on disk has the latest state ──
      const proj = readProjection(root);
      assert.equal(proj._meta.event_count, 6);
      assert.equal(proj.sessions[SID_A].alias, 'integration-test-A');
      assert.equal(proj.sessions[SID_A].outcome, 'done');
      assert.equal(proj.sessions[SID_B].parent_session_id, SID_A);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unknown command exits 3 with helpful message', async () => {
    const r = await runCLI(['nonexistent-subcommand']);
    assert.equal(r.exitCode, 3);
    assert.match(r.stderr, /unknown command/);
  });

  it('--help exits 0 and prints all subcommands', async () => {
    const r = await runCLI(['--help']);
    assert.equal(r.exitCode, 0);
    for (const cmd of ['find', 'tree', 'alias', 'link', 'link-parent', 'close', 'rebuild', 'sweep']) {
      assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`));
    }
  });

  it('subcommand --help shows usage and exits 0', async () => {
    const r = await runCLI(['find', '--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^Usage: sessions-db find/);
  });

  // P5 reshape (was: P4 stub exit 1 / "not implemented"). Sweep now ships;
  // running it against an empty projection (no sessions, no events) returns
  // 0 with a "no transitions needed" message.
  it('sweep against empty workspace exits 0 with no-op message', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, []);
      const rebuild = await runCLI(['rebuild', '--root', root]);
      assert.equal(rebuild.exitCode, 0);
      const r = await runCLI(['sweep', '--root', root]);
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /no transitions needed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run writes nothing to events.jsonl', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, [
        freshEvent('session_seen', SID_A, { claude_session_id: 'c' }),
      ]);
      // rebuild first so projection exists
      const rebuild = await runCLI(['rebuild', '--root', root]);
      assert.equal(rebuild.exitCode, 0);
      const linesBefore = readEvents(root).length;

      const dry = await runCLI([
        'alias', SID_A, 'should-not-persist', '--dry-run', '--root', root,
      ]);
      assert.equal(dry.exitCode, 0);
      assert.match(dry.stdout, /\[dry-run\]/);
      // events.jsonl unchanged
      assert.equal(readEvents(root).length, linesBefore);
      // projection unchanged
      const proj = readProjection(root);
      assert.equal(proj.sessions[SID_A].alias, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('argparse error (unknown flag) exits 2', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, []);
      const r = await runCLI(['find', '--bogus-flag', '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /unknown flag/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('business error (unknown stable_id on alias) exits 1', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, []);
      const r = await runCLI([
        'alias', 'sess_no-such-id-zzzz-zzzz-zzzzzzzzzzzz', 'x', '--root', root,
      ]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /stable_id not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P4 round-1 review fix #2 (end-to-end through dispatcher) — extra
  // positional must surface as exit 2 + clear stderr message. Catches the
  // operator typo `tree <id> garbage` that previously rendered the tree
  // and silently dropped the trailing token.
  it('rejects extra positional through tree subcommand (exit 2)', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, [
        freshEvent('session_seen', SID_A, { claude_session_id: 'csid-A' }),
      ]);
      // Build projection so the stable_id check would otherwise pass.
      const rebuild = await runCLI(['rebuild', '--root', root]);
      assert.equal(rebuild.exitCode, 0);

      const r = await runCLI(['tree', SID_A, 'garbage-token', '--root', root]);
      assert.equal(r.exitCode, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /unexpected extra positional argument\(s\): garbage-token/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P5 reshape (was: P4 reject "--remove not implemented"). Through the
  // dispatcher: --remove now ships and writes a session_unlink event whose
  // reducer filters projection.tasks. Captured here at the OS exit-code
  // layer because the in-process unit test stubs process.exit; this catches
  // any regression in the dispatcher → handler import path.
  it('link --remove --task X dispatches session_unlink end-to-end (exit 0)', async () => {
    const root = mkTmp();
    try {
      // Plant a session that already has the task we want to remove.
      plantEvents(root, [
        freshEvent('session_seen', SID_A, { claude_session_id: 'csid-A' }),
        freshEvent('session_link', SID_A, { tasks: ['feat-foo.md'] }),
      ]);
      const rebuild = await runCLI(['rebuild', '--root', root]);
      assert.equal(rebuild.exitCode, 0);

      const r = await runCLI([
        'link', SID_A, '--task', 'feat-foo.md', '--remove', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /ok: session_unlink written/);

      const proj = readProjection(root);
      assert.deepEqual(proj.sessions[SID_A].tasks, []);
      // Event audit trail: planted (2) + the new unlink event = 3.
      const events = readEvents(root);
      const unlinks = events.filter((e) => e.op === 'session_unlink');
      assert.equal(unlinks.length, 1);
      assert.deepEqual(unlinks[0].payload.tasks, ['feat-foo.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('link --remove with no targets still exits 2 (only reject path that survives)', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, [
        freshEvent('session_seen', SID_A, { claude_session_id: 'csid-A' }),
      ]);
      const rebuild = await runCLI(['rebuild', '--root', root]);
      assert.equal(rebuild.exitCode, 0);
      const r = await runCLI(['link', SID_A, '--remove', '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /requires at least one --task or --project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P4 round-1 review fix #2 (end-to-end through dispatcher) — boolean
  // flag with spaced value must surface as exit 2 not silent --flag=true
  // with the value swallowed as a phantom positional.
  it('rejects boolean flag with spaced value through dispatcher (exit 2)', async () => {
    const root = mkTmp();
    try {
      plantEvents(root, [
        freshEvent('session_seen', SID_A, { claude_session_id: 'csid-A' }),
      ]);
      const rebuild = await runCLI(['rebuild', '--root', root]);
      assert.equal(rebuild.exitCode, 0);

      const r = await runCLI([
        'link', SID_A, '--task', 'feat-foo.md', '--remove', 'false', '--root', root,
      ]);
      assert.equal(r.exitCode, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /boolean flag --remove does not accept a positional value: false/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
