import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// Hook script is the unit-under-test entry point. We spawn it as a child
// process so the test exercises the real top-level wrappers (hard timeout,
// main().catch, kill switch) instead of importing the module and missing
// those side-effects.
const HOOK = join(HERE, '..', '..', 'cli', 'sessions-db-session-start.mjs');
const HOOK_MAIN = join(HERE, '..', '..', 'cli', 'sessions-db-session-start-main.mjs');

function mkTmp(prefix = 'hook-test-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Build a fake druumen workspace: a tmpdir with CLAUDE.md containing the
 * "Druumen Workspace" sentinel + an initialized git repo.
 */
function makeFakeWorkspace(opts = {}) {
  const dir = mkTmp(opts.prefix || 'hook-ws-');
  if (opts.withClaude !== false) {
    writeFileSync(join(dir, 'CLAUDE.md'),
      '# CLAUDE.md\n\nThis is a Druumen Workspace test fixture.\n');
  }
  if (opts.withGit !== false) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const run = (args) => {
      const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
      }
    };
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    run(['add', 'README.md']);
    run(['commit', '-q', '-m', 'init']);
  }
  return dir;
}

/**
 * Build a fake transcript jsonl with one user message + one assistant turn,
 * giving the hook enough to compute lineage_prefix_v1 and first prompt.
 *
 * `opts.firstUuid` / `opts.lastUuid` / `opts.firstParentUuid` let callers
 * craft a transcript whose `firstParentUuid` points at another transcript's
 * `lastUuid` — the resume scenario the P3 lineage matcher resolves.
 */
function makeFakeTranscript(dir, sessionId, opts = {}) {
  const transcriptPath = join(dir, `${sessionId}.jsonl`);
  const firstUuid = opts.firstUuid || '11111111-1111-1111-1111-111111111111';
  const lastUuid = opts.lastUuid || '22222222-2222-2222-2222-222222222222';
  const firstParentUuid = opts.firstParentUuid || null; // null = fresh session
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: firstUuid,
      parentUuid: firstParentUuid,
      sessionId,
      cwd: dir,
      gitBranch: 'main',
      userType: 'external',
      message: { role: 'user', content: opts.firstPrompt || 'hello world from fixture' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: lastUuid,
      parentUuid: firstUuid,
      sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
    }),
  ];
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

/**
 * Spawn the hook with stdin payload + env overrides, capture stdout/stderr/
 * exit code. Wraps a soft 4-second timeout so a hung hook fails the test
 * instead of stalling the suite.
 */
function runHook({ cwd, stdin, env = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hook hung > ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

const FAKE_SID = '12345678-aaaa-bbbb-cccc-1234567890ab';

describe('sessions-db-session-start.mjs (hook integration)', () => {
  // Item 5 of the safety contract: kill switch.
  it('contract-5 kill switch: DRUUMEN_SESSIONS_DB_DISABLED=1 exits 0 without writing events', async () => {
    const ws = makeFakeWorkspace();
    try {
      const eventsPath = join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl');
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { DRUUMEN_SESSIONS_DB_DISABLED: '1', HOME: ws },
      });
      assert.equal(r.code, 0, `exit code: stderr=${r.stderr}`);
      assert.equal(r.stderr, '', `kill-switch path leaked to stderr: ${r.stderr}`);
      assert.equal(existsSync(eventsPath), false,
        'kill-switch path must NOT have written events.jsonl');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Item 1 of the safety contract: cwd-gate.
  it('contract-1 cwd-gate: non-druumen cwd exits 0 without writing events', async () => {
    // Make a workspace with NO CLAUDE.md sentinel — gate must reject it.
    const ws = mkTmp('hook-non-druumen-');
    try {
      const eventsPath = join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl');
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.equal(existsSync(eventsPath), false,
        'cwd-gate fail must NOT write events.jsonl');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('happy path: writes session_seen event + projection record', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-happy-' });
    try {
      // Plant a transcript that the hook can locate via the explicit
      // transcript_path (avoids depending on ~/.claude/projects layout).
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);

      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `exit non-zero. stderr: ${r.stderr}`);
      assert.equal(r.stderr, '', `unexpected stderr: ${r.stderr}`);

      // events.jsonl should now contain exactly one session_seen line.
      const eventsPath = join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl');
      assert.equal(existsSync(eventsPath), true, 'events.jsonl should exist');
      const eventLines = readFileSync(eventsPath, 'utf8').trim().split('\n');
      assert.equal(eventLines.length, 1, `expected 1 event, got ${eventLines.length}`);
      const event = JSON.parse(eventLines[0]);
      assert.equal(event.op, 'session_seen');
      assert.match(event.stable_id, /^sess_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      assert.equal(event.payload.claude_session_id, FAKE_SID);
      assert.equal(event.payload.branch_at_start, 'main');
      assert.equal(event.payload.branch_current, 'main');
      assert.ok(event.payload.head_at_start && /^[0-9a-f]{40}$/.test(event.payload.head_at_start));
      assert.equal(event.payload.cwd, ws);
      assert.ok(event.payload.transcript_file, 'transcript_file should be populated');
      assert.equal(event.payload.transcript_file.path, transcriptPath);
      assert.equal(event.payload.transcript_file.first_uuid, '11111111-1111-1111-1111-111111111111');
      assert.equal(event.payload.transcript_file.last_uuid, '22222222-2222-2222-2222-222222222222');
      assert.equal(event.payload.first_prompt_preview, 'hello world from fixture');
      assert.ok(event.payload.fingerprints.first_human_prompt_v1, 'first_human_prompt_v1 should be set');
      assert.ok(event.payload.fingerprints.lineage_prefix_v1, 'lineage_prefix_v1 should be set');

      // projection cache should also exist with the new session.
      const projectionPath = join(ws, 'tickets', '_logs', 'sessions-db.json');
      assert.equal(existsSync(projectionPath), true, 'projection cache should exist');
      const projection = JSON.parse(readFileSync(projectionPath, 'utf8'));
      const sessionRecord = projection.sessions[event.stable_id];
      assert.ok(sessionRecord, 'session record should be in projection');
      assert.deepEqual(sessionRecord.claude_session_ids, [FAKE_SID]);
      assert.equal(sessionRecord.branch_at_start, 'main');
      assert.equal(sessionRecord.first_prompt_preview, 'hello world from fixture');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Item 6 (shared lib) is implicitly covered by the happy path — the hook
  // imports from ../_lib/git-context.mjs and the projection only fills with
  // git context when that lib succeeds. The next test covers item 4 directly.

  // Item 4 of the safety contract: always exit 0.
  it('contract-4 always exit 0: malformed stdin produces exit 0 with no stderr', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-bad-stdin-' });
    try {
      // Stdin is a non-JSON garbage string; readStdinJson returns null and
      // the hook should fall through cleanly (no claude_session_id => exit 0).
      const r = await runHook({
        cwd: ws,
        stdin: '{not valid json at all}}}',
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '', `should be silent; got: ${r.stderr}`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('contract-4 always exit 0: corrupted projection cache does not break the hook', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-bad-projection-' });
    try {
      // Pre-plant a corrupted projection — loadProjection inside resolveStableId
      // should fall back to rebuild-from-events (empty), and the hook should
      // still complete and exit 0.
      const logsDir = join(ws, 'tickets', '_logs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(logsDir, 'sessions-db.json'), '{ corrupted not json }');

      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Item 3 of the safety contract: silent stderr.
  it('contract-3 silent stderr: hook source has no executable console.error / console.warn calls', () => {
    // We match call shapes (`console.error(` / `console.warn(`) rather than
    // bare substrings so the contract docstrings ("never console.errors")
    // can still describe the rule. A real call site would always end in `(`.
    const src = readFileSync(HOOK, 'utf8');
    assert.equal(/console\.error\s*\(/.test(src), false,
      'hook script must not contain console.error( call');
    assert.equal(/console\.warn\s*\(/.test(src), false,
      'hook script must not contain console.warn( call');
  });

  // Item 2 of the safety contract: < 2 second budget. Realistic happy-path
  // timing test — a workspace + git init + transcript parse + projection
  // write should comfortably finish well under 2.5s. We give 2.5s headroom
  // over the 2s hard timeout to absorb test machine variance.
  it('contract-2 timeout: happy path completes in < 2.5s end-to-end', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-timing-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const start = Date.now();
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: { HOME: ws },
      });
      const elapsed = Date.now() - start;
      assert.equal(r.code, 0);
      assert.ok(elapsed < 2500, `hook took ${elapsed}ms, expected < 2500ms`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('identity reuse: second invocation with same claude_session_id reuses stable_id', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-identity-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const stdin = JSON.stringify({
        session_id: FAKE_SID,
        cwd: ws,
        transcript_path: transcriptPath,
      });
      const r1 = await runHook({ cwd: ws, stdin, env: { HOME: ws } });
      assert.equal(r1.code, 0);

      const r2 = await runHook({ cwd: ws, stdin, env: { HOME: ws } });
      assert.equal(r2.code, 0);

      const events = readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
      assert.equal(events[0].stable_id, events[1].stable_id,
        'second invocation must reuse the same stable_id (claude_session_id index lookup)');

      // Projection should still have exactly one session.
      const projection = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db.json'),
        'utf8',
      ));
      assert.equal(Object.keys(projection.sessions).length, 1,
        'should have exactly one session record after dedup');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('non-uuid session_id is rejected (bails before writing events)', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-bad-sid-' });
    try {
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: 'not-a-uuid',
          cwd: ws,
        }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      const eventsPath = join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl');
      assert.equal(existsSync(eventsPath), false,
        'non-uuid session_id must NOT write an event');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // P2 round-1 codex review: 7 new tests covering the four MUST-PATCH fixes.
  // -------------------------------------------------------------------------

  /**
   * Build a fake `git` shim that sleeps forever, drop it into a tmpdir, and
   * return that tmpdir so callers can prepend it to PATH. The shim execs
   * `sleep 30` so it ignores SIGTERM cleanly only when SIGKILL arrives —
   * exactly the worst case for a hook trying to honor a 2-second budget.
   */
  function makeHungGitDir() {
    const dir = mkTmp('hook-fake-git-hang-');
    const gitPath = join(dir, 'git');
    writeFileSync(gitPath, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(gitPath, 0o755);
    return dir;
  }

  /**
   * Fake `git` that writes the given message to stderr and exits non-zero.
   * Used to verify our hook never leaks stderr from a misbehaving git probe.
   */
  function makeFailingGitDir(stderrMessage) {
    const dir = mkTmp('hook-fake-git-fail-');
    const gitPath = join(dir, 'git');
    writeFileSync(
      gitPath,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderrMessage)} 1>&2\nexit 128\n`,
    );
    chmodSync(gitPath, 0o755);
    return dir;
  }

  // MUST-PATCH 1 — true hard-timeout. With async runGit + global deadline,
  // even a permanently hung `git` binary cannot exceed our 2s budget. Old
  // spawnSync code blocked the event loop; the bootstrap setTimeout never
  // fired. New code uses spawn + Promise.race so the timer wins.
  it('MUST-PATCH 1: hard timeout fires within 2s when git hangs forever', async (t) => {
    // Windows skip: `makeHungGitDir()` produces a #!/bin/sh shebang fake git
    // binary which Windows can't execute (no /bin/sh; chmod 0o755 not
    // executable semantics). On Windows the PATH-override fake never runs,
    // PATH falls through to real git which answers fast (~100ms), hook
    // exits early — never tests the 2s hard-timeout fire path. Production
    // setTimeout(2000).unref() is platform-neutral Node API; contract
    // verified on POSIX CI. Post-0.1.0 hardening: replace shebang fake with
    // Windows-aware `git.cmd` doing `ping -n 30 127.0.0.1 > nul`.
    if (process.platform === 'win32') {
      t.skip('Windows: shebang fake-git unsupported; 2s hard timeout contract verified on POSIX CI');
      return;
    }
    const fakeGitDir = makeHungGitDir();
    const ws = makeFakeWorkspace({ prefix: 'hook-hung-git-', withGit: false });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const start = Date.now();
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: {
          HOME: ws,
          // Prepend the fake git dir so spawn('git', ...) resolves to our
          // hanging shim instead of the real binary.
          PATH: `${fakeGitDir}${delimiter}${process.env.PATH}`,
        },
        // Allow up to 3s — we want to verify the hook exits within the 2s
        // budget but give some headroom for spawn overhead on slow CI boxes.
        timeoutMs: 3000,
      });
      const elapsed = Date.now() - start;
      assert.equal(r.code, 0, `hook should exit 0 even on hung git; stderr=${r.stderr}`);
      assert.ok(
        elapsed >= 1500 && elapsed <= 2500,
        `hard timeout should fire in ~2s window; got ${elapsed}ms`,
      );
    } finally {
      rmSync(fakeGitDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // MUST-PATCH 2 — concurrent same-claude_session_id collapses to one
  // stable_id. Old code did lookup+mint outside the lock so two parallel
  // hooks each minted distinct stable_ids; new recordSessionSeen holds the
  // lock across the entire critical section.
  it('MUST-PATCH 2: two concurrent hooks for same claude_session_id reuse single stable_id', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-concurrent-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const stdin = JSON.stringify({
        session_id: FAKE_SID,
        cwd: ws,
        transcript_path: transcriptPath,
      });

      // Fire both processes simultaneously. The lock acquisition serializes
      // them but the lookup-vs-mint race is what we're stress-testing.
      const [r1, r2] = await Promise.all([
        runHook({ cwd: ws, stdin, env: { HOME: ws } }),
        runHook({ cwd: ws, stdin, env: { HOME: ws } }),
      ]);
      assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);
      assert.equal(r2.code, 0, `r2 stderr: ${r2.stderr}`);

      const events = readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(events.length, 2,
        `expected 2 session_seen events, got ${events.length}`);
      const uniqueStableIds = new Set(events.map((e) => e.stable_id));
      assert.equal(uniqueStableIds.size, 1,
        `concurrent hooks must collapse to ONE stable_id; got ${[...uniqueStableIds].join(', ')}`);

      const projection = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db.json'),
        'utf8',
      ));
      assert.equal(Object.keys(projection.sessions).length, 1,
        'projection must hold exactly one session record');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // MUST-PATCH 4 — cwd plumb-through. Hook is spawned from cwd A but the
  // payload says cwd=B. Storage must anchor on B, not on A's tickets/_logs.
  it('MUST-PATCH 4: payload cwd anchors storage path, not process.cwd()', async () => {
    const wsA = mkTmp('hook-cwd-a-');
    const wsB = makeFakeWorkspace({ prefix: 'hook-cwd-b-' });
    try {
      const transcriptPath = makeFakeTranscript(wsB, FAKE_SID);
      const r = await runHook({
        cwd: wsA, // process.cwd() = A — random place Claude spawned us from
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: wsB, // payload cwd = B — the real project
          transcript_path: transcriptPath,
        }),
        env: { HOME: wsB },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stderr, '');

      const eventsB = join(wsB, 'tickets', '_logs', 'sessions-db-events.jsonl');
      const eventsA = join(wsA, 'tickets', '_logs', 'sessions-db-events.jsonl');
      assert.equal(existsSync(eventsB), true,
        'events.jsonl must exist under payload cwd (B)');
      assert.equal(existsSync(eventsA), false,
        'events.jsonl must NOT be written under process.cwd() (A)');
    } finally {
      rmSync(wsA, { recursive: true, force: true });
      rmSync(wsB, { recursive: true, force: true });
    }
  });

  // MUST-PATCH 1 / contract-3 — failing git binary writing stderr must not
  // leak through to our hook's stderr. The async runGit captures stderr
  // chunks and pushes a one-line diagnostic into ctx.errors only.
  it('MUST-PATCH 1: stderr from a failing git binary stays inside the probe (no leak)', async () => {
    const fakeGitDir = makeFailingGitDir('fatal: simulated git failure for test');
    const ws = makeFakeWorkspace({ prefix: 'hook-failing-git-', withGit: false });
    try {
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
        }),
        env: {
          HOME: ws,
          PATH: `${fakeGitDir}${delimiter}${process.env.PATH}`,
        },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '',
        `hook stderr must remain empty even when git probes fail; got: ${r.stderr}`);
    } finally {
      rmSync(fakeGitDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // MUST-PATCH 2 — pre-planted projection with empty claude_session_ids[]
  // must NOT false-match. Old reverse-lookup loop (`includes`) on empty
  // arrays returned false anyway, but the new findStableIdByClaudeSessionId
  // explicitly skips the empty case to make the contract obvious to future
  // maintainers (e.g. when manual_link can pre-create skeleton sessions).
  it('MUST-PATCH 2: pre-existing record with empty claude_session_ids[] does not false-match', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-empty-csids-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      // Pre-plant a projection that contains a record with NO
      // claude_session_ids — simulating a session created via some other
      // op (manual_link, parent_set on a synthetic id, etc.).
      const logsDir = join(ws, 'tickets', '_logs');
      mkdirSync(logsDir, { recursive: true });
      const planted = {
        _meta: {
          schema_version: 2,
          fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
          updated: new Date().toISOString(),
          event_count: 0,
          last_event_id: null,
        },
        sessions: {
          'sess_planted-skeleton-record': {
            stable_id: 'sess_planted-skeleton-record',
            alias: null,
            claude_session_ids: [], // <-- empty, must not be the match target
            transcript_files: [],
            fingerprints: { first_human_prompt_v1: null, lineage_prefix_v1: null },
            parent_session_id: null,
            parent_candidate_ids: [],
            worktree_path_observed: null,
            worktree_realpath: null,
            worktree_registry_name: null,
            git_common_dir: null,
            branch_at_start: null,
            branch_current: null,
            head_at_start: null,
            head_last_seen: null,
            tasks: [],
            projects: [],
            activity_state: 'active',
            outcome: 'open',
            closed_at: null,
            closed_reason: null,
            created_at: new Date().toISOString(),
            last_progress_at: new Date().toISOString(),
            first_prompt_preview: null,
          },
        },
      };
      writeFileSync(join(logsDir, 'sessions-db.json'), JSON.stringify(planted, null, 2));

      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const projection = JSON.parse(readFileSync(
        join(logsDir, 'sessions-db.json'),
        'utf8',
      ));
      // The planted skeleton must remain; our new event mints a NEW
      // stable_id, so we should now have 2 session records.
      assert.ok(projection.sessions['sess_planted-skeleton-record'],
        'planted skeleton should still exist');
      assert.equal(Object.keys(projection.sessions).length, 2,
        'should have minted a fresh stable_id for the new claude_session_id');

      // The newly-minted record must be the one with FAKE_SID.
      const minted = Object.values(projection.sessions).find(
        (s) => s.claude_session_ids.includes(FAKE_SID),
      );
      assert.ok(minted, 'minted session record should have FAKE_SID');
      assert.notEqual(minted.stable_id, 'sess_planted-skeleton-record',
        'must NOT have merged into the empty-csids skeleton record');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // MUST-PATCH 4 + identity reuse: two hook invocations with the SAME
  // claude_session_id but called from different cwds inside the same git
  // worktree should still resolve to the same stable_id. The hook's
  // storageRoot resolution (gitCtx.worktreePath) anchors both calls to
  // the worktree root regardless of which subdirectory Claude spawned us
  // from — combined with recordSessionSeen's atomic identity lookup, this
  // gives us "same session, same stable_id" even across cwd drift.
  it('MUST-PATCH 4 + 2: identity reuse across different cwds within the same worktree', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-cwd-reuse-' });
    try {
      // Make a subdirectory inside ws — both invocations will pass cwd=ws
      // so the hook anchors on the worktree root either way. (Spawning from
      // wsSub with payload cwd=ws is the realistic scenario: Claude spawns
      // hooks from whatever process.cwd() it has, but the payload always
      // carries the project cwd.)
      const wsSub = join(ws, 'subdir');
      mkdirSync(wsSub);
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const stdin = JSON.stringify({
        session_id: FAKE_SID,
        cwd: ws,
        transcript_path: transcriptPath,
      });

      const r1 = await runHook({ cwd: ws, stdin, env: { HOME: ws } });
      const r2 = await runHook({ cwd: wsSub, stdin, env: { HOME: ws } });
      assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);
      assert.equal(r2.code, 0, `r2 stderr: ${r2.stderr}`);

      const events = readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(events.length, 2);
      assert.equal(events[0].stable_id, events[1].stable_id,
        'cross-cwd hooks for same csid must reuse stable_id');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // P3 identity reconciliation: 2 integration tests covering the resume-via-
  // transcript-lineage case and the cross-cwd fingerprint rejection case.
  // -------------------------------------------------------------------------

  // P3 — Resume scenario: two hooks fire with DIFFERENT csid, but the second
  // transcript's first record points at the first transcript's tail. The
  // P2 lineage matcher must resolve them to the same stable_id.
  it('P3 resume: second transcript with firstParentUuid → first transcript lastUuid reuses stable_id', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-p3-resume-' });
    try {
      // Transcript A: fresh session (firstParentUuid=null), tail = uuid-tail-A.
      const FAKE_SID_A = '12345678-aaaa-bbbb-cccc-aaaaaaaaaaaa';
      const transcriptA = makeFakeTranscript(ws, FAKE_SID_A, {
        firstUuid: 'uuid-first-A',
        lastUuid: 'uuid-tail-A',
        firstParentUuid: null,
      });

      // Transcript B: DIFFERENT csid + DIFFERENT firstUuid, but its
      // firstParentUuid points at A's tail. This is the canonical resume
      // signal — Claude Code forks transcripts but preserves parent_uuid.
      const FAKE_SID_B = '12345678-bbbb-cccc-dddd-bbbbbbbbbbbb';
      const transcriptB = makeFakeTranscript(ws, FAKE_SID_B, {
        firstUuid: 'uuid-first-B',
        lastUuid: 'uuid-tail-B',
        firstParentUuid: 'uuid-tail-A', // <-- the resume link
      });

      const r1 = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID_A, cwd: ws, transcript_path: transcriptA }),
        env: { HOME: ws },
      });
      assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);
      const r2 = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID_B, cwd: ws, transcript_path: transcriptB }),
        env: { HOME: ws },
      });
      assert.equal(r2.code, 0, `r2 stderr: ${r2.stderr}`);

      const events = readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(events.length, 2);
      assert.equal(
        events[0].stable_id, events[1].stable_id,
        'P2 lineage match must collapse two csids to one stable_id',
      );

      // The second event's identity_resolution audit trail must call out P2.
      assert.equal(events[1].payload.identity_resolution.source, 'transcript_lineage');
      assert.equal(events[1].payload.identity_resolution.confidence, 'high');

      // Projection has one session, two csids.
      const projection = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db.json'),
        'utf8',
      ));
      assert.equal(Object.keys(projection.sessions).length, 1);
      const session = projection.sessions[events[0].stable_id];
      assert.deepEqual(session.claude_session_ids.sort(), [FAKE_SID_A, FAKE_SID_B].sort());
      // Latest identity_resolution wins on the session record.
      assert.equal(session.identity_resolution.source, 'transcript_lineage');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // P3 — Fingerprint cross-session rejection: two DIFFERENT git worktrees
  // (different cwd, different worktree_realpath) with identical first prompt.
  //
  // Reshape note (P3 patch round-1): the original assertion relied on the
  // "any 2 of 4 corroborators" gate. Post-patch, acceptance now requires
  // ≥1 STRONG corroborator (same_cwd OR same_worktree_realpath) AND total
  // ≥ minCorroborators. Two distinct worktrees can never share strong
  // corroborators → rejection is now structural rather than threshold-
  // dependent. We dropped the previous `git checkout -b feature-x` step
  // because branch divergence is no longer load-bearing for rejection.
  //
  // Expectation: distinct stable_ids + parent_candidate_ids surfaces the
  // cross-session hint. Even though same_branch_at_start AND
  // within_time_window both hit (weak=2, total=2), strong=0 fails the
  // strong-corroborator gate.
  it('P3 fingerprint cross-cwd: weak-only corroborators do NOT merge identity (strong=0 → reject + parent_candidate)', async () => {
    const wsA = makeFakeWorkspace({ prefix: 'hook-p3-fpA-' });
    const wsB = makeFakeWorkspace({ prefix: 'hook-p3-fpB-' });
    try {
      // Both workspaces use the same first prompt (same first_human_prompt_v1
      // fingerprint) but live in different git roots → different cwd, no
      // shared worktree_realpath. Both default to `main` branch + both start
      // moments apart, so weak corroborators (same_branch_at_start +
      // within_time_window) both hit. Pre-patch: this would FALSE-MERGE.
      // Post-patch: strong=0 → must reject.
      const FAKE_SID_A = '12345678-cccc-eeee-ffff-cccccccccccc';
      const FAKE_SID_B = '12345678-dddd-eeee-ffff-dddddddddddd';
      const SAME_PROMPT = 'shared prompt for fingerprint test';

      const transcriptA = makeFakeTranscript(wsA, FAKE_SID_A, {
        firstUuid: 'uuid-A1', lastUuid: 'uuid-A2', firstParentUuid: null,
        firstPrompt: SAME_PROMPT,
      });
      const transcriptB = makeFakeTranscript(wsB, FAKE_SID_B, {
        firstUuid: 'uuid-B1', lastUuid: 'uuid-B2', firstParentUuid: null,
        firstPrompt: SAME_PROMPT,
      });

      // First hook → mints stable_id A, fingerprint stored in wsA's projection.
      const r1 = await runHook({
        cwd: wsA,
        stdin: JSON.stringify({ session_id: FAKE_SID_A, cwd: wsA, transcript_path: transcriptA }),
        env: { HOME: wsA },
      });
      assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);

      // Pre-plant the wsA projection into wsB so the second hook actually
      // sees the prior session as a candidate. (Independent storage roots
      // would otherwise hide the cross-session signal entirely; the
      // realistic scenario is two sessions sharing the same workspace.)
      const wsAProjection = JSON.parse(readFileSync(
        join(wsA, 'tickets', '_logs', 'sessions-db.json'),
        'utf8',
      ));
      const wsAEvents = readFileSync(
        join(wsA, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      );
      const logsB = join(wsB, 'tickets', '_logs');
      mkdirSync(logsB, { recursive: true });
      writeFileSync(join(logsB, 'sessions-db.json'), JSON.stringify(wsAProjection, null, 2));
      writeFileSync(join(logsB, 'sessions-db-events.jsonl'), wsAEvents);

      // Second hook in wsB — different cwd + different worktree_realpath,
      // SAME branch ('main') + within time window. Strong corroborators = 0
      // (cwd / worktree_realpath both miss). Weak corroborators = 2
      // (same_branch_at_start + within_time_window). Pre-patch this would
      // accept (any 2 → accept). Post-patch must reject (strong=0).
      const r2 = await runHook({
        cwd: wsB,
        stdin: JSON.stringify({ session_id: FAKE_SID_B, cwd: wsB, transcript_path: transcriptB }),
        env: { HOME: wsB },
      });
      assert.equal(r2.code, 0, `r2 stderr: ${r2.stderr}`);

      // Projection in wsB now has BOTH the planted A record AND a freshly
      // minted B record.
      const projB = JSON.parse(readFileSync(
        join(logsB, 'sessions-db.json'),
        'utf8',
      ));
      assert.equal(
        Object.keys(projB.sessions).length, 2,
        'cross-cwd fingerprint match (strong=0) must NOT merge identity — expect 2 sessions',
      );
      // The new event's payload must surface the prior session as a parent_candidate.
      const eventsB = readFileSync(
        join(logsB, 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      // Last event is the wsB hook's session_seen.
      const lastEvent = eventsB[eventsB.length - 1];
      assert.equal(lastEvent.payload.identity_resolution.source, 'minted',
        'minted (not merged) — strong=0 corroborator gate failed');
      assert.ok(Array.isArray(lastEvent.payload.parent_candidate_ids));
      assert.equal(lastEvent.payload.parent_candidate_ids.length, 1);
      // Reason payload calls out strong=0 to make the rejection self-describing.
      assert.equal(lastEvent.payload.parent_candidate_ids[0].reason.strong_corroborator_count, 0,
        'rejected candidate reason must record strong=0 (the rejection trigger)');
      // The candidate is the prior session (from wsA, planted into wsB).
      const priorIds = Object.keys(projB.sessions).filter((sid) => sid !== lastEvent.stable_id);
      assert.equal(priorIds.length, 1);
      assert.equal(lastEvent.payload.parent_candidate_ids[0].stable_id, priorIds[0]);
    } finally {
      rmSync(wsA, { recursive: true, force: true });
      rmSync(wsB, { recursive: true, force: true });
    }
  });

  // P3 — Same cwd → merge: confirms the OTHER side of the strong-corroborator
  // gate. Two hooks fire in the SAME workspace (same cwd, same realpath, same
  // branch, both within time window) with the same first prompt fingerprint
  // and DIFFERENT csid. Strong=2 + weak=2 → accept identity (low confidence).
  // This used to be implicitly covered by "fingerprint cross-session" being
  // permissive about branch/time-only signals; we now spell out the
  // accept-side as a regression guard.
  it('P3 fingerprint same-cwd: strong corroborators (cwd + worktree_realpath) DO merge identity', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-p3-same-cwd-' });
    try {
      const FAKE_SID_A = '12345678-aaaa-1111-1111-aaaaaaaaaaaa';
      const FAKE_SID_B = '12345678-bbbb-2222-2222-bbbbbbbbbbbb';
      const SAME_PROMPT = 'merge-me prompt';

      // Two transcripts with different csids + DIFFERENT firstParentUuid (not
      // a transcript_lineage resume) but identical first prompt
      // (first_human_prompt_v1 collision). Same workspace → same_cwd +
      // same_worktree_realpath both hit (strong=2).
      const transcriptA = makeFakeTranscript(ws, FAKE_SID_A, {
        firstUuid: 'uuid-merge-A1', lastUuid: 'uuid-merge-A2', firstParentUuid: null,
        firstPrompt: SAME_PROMPT,
      });
      const transcriptB = makeFakeTranscript(ws, FAKE_SID_B, {
        firstUuid: 'uuid-merge-B1', lastUuid: 'uuid-merge-B2', firstParentUuid: null,
        firstPrompt: SAME_PROMPT,
      });

      const r1 = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID_A, cwd: ws, transcript_path: transcriptA }),
        env: { HOME: ws },
      });
      assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);

      const r2 = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID_B, cwd: ws, transcript_path: transcriptB }),
        env: { HOME: ws },
      });
      assert.equal(r2.code, 0, `r2 stderr: ${r2.stderr}`);

      // Projection should hold ONE session with both csids merged.
      const proj = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db.json'),
        'utf8',
      ));
      assert.equal(
        Object.keys(proj.sessions).length, 1,
        'same-workspace fingerprint match (strong=2) must merge identity',
      );
      const events = readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(events.length, 2);
      assert.equal(events[0].stable_id, events[1].stable_id,
        'second hook must reuse the first hook\'s stable_id (P3 strong-corroborator accept)');
      assert.equal(events[1].payload.identity_resolution.source, 'fingerprint_corroborator');
      assert.equal(events[1].payload.identity_resolution.confidence, 'low');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // P3 — Ambiguous P3 match: two prior sessions in the same workspace both
  // share the fingerprint AND both pass the strong-corroborator gate. The
  // patch refuses to silently pick the first projection-iteration entry —
  // mints a fresh stable_id and surfaces both as parent_candidates so a
  // human / future manual_link can disambiguate.
  it('P3 ambiguous: two prior sessions both above threshold → MINT new stable_id + surface both candidates', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-p3-ambig-' });
    try {
      const FAKE_SID_A = '12345678-1111-aaaa-bbbb-aaaaaaaaaaaa';
      const FAKE_SID_B = '12345678-2222-bbbb-cccc-bbbbbbbbbbbb';
      const FAKE_SID_C = '12345678-3333-cccc-dddd-cccccccccccc';
      const SHARED_PROMPT = 'same prompt across three sessions';

      // Plant 3 transcripts. A and B both seed sessions with SAME prompt +
      // SAME workspace (so each gets strong=2 against any later hook
      // signal). C is the new hook — same prompt → fingerprint hits both
      // A and B. Ambiguous → mint.
      //
      // Subtlety: the FIRST and SECOND hooks (A, B) themselves go through
      // identity resolution. A mints fresh (no prior). B then sees A as a
      // strong-corroborator match → P3 accepts B as A's identity (collapse
      // into A). To get TWO distinct prior sessions we have to manually
      // plant the second one with a different stable_id, bypassing the hook.
      // We do that by appending a synthesized session_seen event for B
      // directly to events.jsonl + rebuilding.
      const transcriptA = makeFakeTranscript(ws, FAKE_SID_A, {
        firstUuid: 'uuid-A1', lastUuid: 'uuid-A2', firstParentUuid: null,
        firstPrompt: SHARED_PROMPT,
      });
      const r1 = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID_A, cwd: ws, transcript_path: transcriptA }),
        env: { HOME: ws },
      });
      assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);

      // Read A's stable_id from events.jsonl.
      const eventsAfterA = readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n').map((l) => JSON.parse(l));
      const aStableId = eventsAfterA[0].stable_id;
      const aFingerprint = eventsAfterA[0].payload.fingerprints;

      // Synthesize a SECOND session in the same workspace with the same
      // fingerprint by writing a session_seen event with a different
      // stable_id directly. Then rebuild the projection so both records
      // appear. (Real-world this happens when manual_link or sweep created
      // a sibling session that shares the same workspace + fingerprint.)
      const syntheticStableId = 'sess_01970000-0000-7000-8000-feedfacefeed';
      const syntheticEvent = {
        ts: new Date().toISOString(),
        event_id: 'evt_synth-ambig-seed',
        op: 'session_seen',
        stable_id: syntheticStableId,
        payload: {
          claude_session_id: 'csid-synthetic-prior',
          cwd: ws,
          worktree_realpath: ws,
          branch_at_start: 'main',
          fingerprints: aFingerprint,
          identity_resolution: { source: 'minted', confidence: 'minted', matched: {} },
        },
      };
      const eventsPath = join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl');
      writeFileSync(eventsPath,
        readFileSync(eventsPath, 'utf8') + JSON.stringify(syntheticEvent) + '\n');
      // Rebuild projection from events.jsonl so the second record materializes.
      const { rebuildProjection } = await import('../../lib/storage.mjs');
      await rebuildProjection({ root: ws });

      // Now fire the third hook. Both aStableId AND syntheticStableId are
      // in the workspace, both share the fingerprint, both have strong=2
      // against the new hook → ambiguous → mint.
      const transcriptC = makeFakeTranscript(ws, FAKE_SID_C, {
        firstUuid: 'uuid-C1', lastUuid: 'uuid-C2', firstParentUuid: null,
        firstPrompt: SHARED_PROMPT,
      });
      const r3 = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID_C, cwd: ws, transcript_path: transcriptC }),
        env: { HOME: ws },
      });
      assert.equal(r3.code, 0, `r3 stderr: ${r3.stderr}`);

      // Final projection has 3 sessions: A, synthetic, and the newly-minted C.
      const proj = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db.json'),
        'utf8',
      ));
      assert.equal(Object.keys(proj.sessions).length, 3,
        'ambiguous P3 must mint new stable_id, not collapse into either prior');

      const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const lastEvent = events[events.length - 1];
      assert.equal(lastEvent.payload.identity_resolution.source, 'minted',
        'ambiguous P3 (≥2 above threshold) must MINT, not pick first');
      assert.equal(lastEvent.payload.identity_resolution.matched.ambiguous, true,
        'matched.ambiguous must be true for the audit trail');
      assert.equal(lastEvent.payload.identity_resolution.matched.ambiguous_count, 2);
      assert.equal(lastEvent.payload.parent_candidate_ids.length, 2,
        'both above-threshold candidates must surface');
      const candidateIds = lastEvent.payload.parent_candidate_ids
        .map((c) => c.stable_id).sort();
      assert.deepEqual(candidateIds, [aStableId, syntheticStableId].sort());
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Privacy opt-out (cockpit Setup Wizard alignment 2026-05-11): hook reads
  // DRUUMEN_SESSIONS_DB_STORE_PREVIEW from env and forwards to
  // recordSessionSeen as `storeFirstPrompt: boolean`. Default keeps the
  // 0.1.0-dev preview behavior; '0' / 'false' (case-insensitive) opt out.
  // -------------------------------------------------------------------------

  it('privacy: DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0 → events.jsonl payload first_prompt_preview === null', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-privacy-zero-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: {
          HOME: ws,
          DRUUMEN_SESSIONS_DB_STORE_PREVIEW: '0',
        },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stderr, '');

      const eventsPath = join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl');
      const event = JSON.parse(
        readFileSync(eventsPath, 'utf8').trim().split('\n')[0],
      );
      assert.equal(event.op, 'session_seen');
      assert.equal(event.payload.first_prompt_preview, null,
        'env=0 must clear first_prompt_preview');
      // Fingerprints stay so identity reconciliation still works.
      assert.ok(event.payload.fingerprints.first_human_prompt_v1,
        'fingerprints must NOT be stripped (identity depends on them)');
      // transcript_file metadata still attached (lineage matching needs it).
      assert.ok(event.payload.transcript_file,
        'transcript_file meta must NOT be stripped');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('privacy: DRUUMEN_SESSIONS_DB_STORE_PREVIEW=False (case-insensitive) → null preview', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-privacy-falseci-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: {
          HOME: ws,
          // Mixed-case "False" — cockpit's Setup Wizard might write either
          // canonical 'false' or capitalized 'False' depending on serializer.
          DRUUMEN_SESSIONS_DB_STORE_PREVIEW: 'False',
        },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const event = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n')[0]);
      assert.equal(event.payload.first_prompt_preview, null,
        'env=False (case-insensitive) must clear preview');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('privacy: DRUUMEN_SESSIONS_DB_STORE_PREVIEW unset → preview filled (default-on backward compat)', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-privacy-unset-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        // env intentionally OMITS DRUUMEN_SESSIONS_DB_STORE_PREVIEW —
        // unset must preserve current 0.1.0-dev preview behavior.
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const event = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n')[0]);
      assert.equal(event.payload.first_prompt_preview, 'hello world from fixture',
        'unset env must default-on (preview persisted) — backward compat');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('privacy: DRUUMEN_SESSIONS_DB_STORE_PREVIEW=1 → preview filled (explicit-on)', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-privacy-one-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: {
          HOME: ws,
          DRUUMEN_SESSIONS_DB_STORE_PREVIEW: '1',
        },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const event = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n')[0]);
      assert.equal(event.payload.first_prompt_preview, 'hello world from fixture',
        'env=1 must keep preview (only 0/false opt out)');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('privacy: DRUUMEN_SESSIONS_DB_STORE_PREVIEW=truthy → preview filled (only "0"/"false" disable)', async () => {
    // Asymmetric semantics test: any value other than the two canonical
    // off-strings is treated as default-on. Protects against a typo opt-out
    // accidentally being interpreted as something it isn't.
    const ws = makeFakeWorkspace({ prefix: 'hook-privacy-truthy-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          transcript_path: transcriptPath,
        }),
        env: {
          HOME: ws,
          DRUUMEN_SESSIONS_DB_STORE_PREVIEW: 'truthy',
        },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const event = JSON.parse(readFileSync(
        join(ws, 'tickets', '_logs', 'sessions-db-events.jsonl'),
        'utf8',
      ).trim().split('\n')[0]);
      assert.equal(event.payload.first_prompt_preview, 'hello world from fixture',
        'unrecognized env value must default-on (only "0"/"false" disable)');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // MUST-PATCH 3 — kill switch must short-circuit BEFORE the dynamic
  // import fires, so a corrupted main module never gets a chance to throw.
  it('MUST-PATCH 3: kill switch exits 0 before importing main, even if main is unimportable', async () => {
    const ws = makeFakeWorkspace({ prefix: 'hook-killswitch-bootstrap-' });
    const movedMain = `${HOOK_MAIN}.MOVED-FOR-TEST`;
    try {
      // Move the real main module aside so dynamic import would fail with
      // ERR_MODULE_NOT_FOUND. With kill switch armed, the bootstrap should
      // exit 0 BEFORE attempting the import.
      renameSync(HOOK_MAIN, movedMain);
      const r = await runHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: {
          DRUUMEN_SESSIONS_DB_DISABLED: '1',
          HOME: ws,
        },
      });
      assert.equal(r.code, 0, 'kill switch should exit 0 silently');
      assert.equal(r.stderr, '',
        `kill-switch path must NOT leak import error to stderr; got: ${r.stderr}`);
    } finally {
      // Restore main module before any other test runs (node:test runs
      // describe blocks sequentially per file, but defensive restore here
      // protects against test-order surprises).
      if (existsSync(movedMain)) {
        renameSync(movedMain, HOOK_MAIN);
      }
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
