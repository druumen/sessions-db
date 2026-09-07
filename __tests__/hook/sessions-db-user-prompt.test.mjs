/**
 * Integration tests for the `UserPromptSubmit` hook + the deferral half of
 * `SessionStart` that it partners with.
 *
 * These spawn the real hook scripts as child processes (never import the main
 * module) so the top-level wrappers — bootstrap kill switch, hard timeout,
 * `main().catch` — are actually exercised. Importing would test the logic and
 * silently skip every safety net.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROMPT_HOOK = join(HERE, '..', '..', 'cli', 'sessions-db-user-prompt.mjs');
const PROMPT_HOOK_MAIN = join(HERE, '..', '..', 'cli', 'sessions-db-user-prompt-main.mjs');
const START_HOOK = join(HERE, '..', '..', 'cli', 'sessions-db-session-start.mjs');

const FAKE_SID = 'aaaaaaaa-1111-2222-3333-444444444444';

function mkTmp(prefix = 'prompt-hook-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Write the promoter liveness marker into a storage directory.
 *
 * SessionStart refuses to defer unless it can see this marker, because a user
 * who upgraded the package without registering `UserPromptSubmit` would
 * otherwise get deferral with nothing to promote — no sessions recorded at all,
 * silently. Every test that expects deferral therefore has to establish the
 * same precondition production has: a machine where the prompt hook has run at
 * least once. Planting the file keeps those tests fast; the real two-hook
 * handshake that creates it is covered separately by its own test.
 */
function plantPromoterMarker(storageDirPath) {
  mkdirSync(join(storageDirPath, 'sessions-db-pending'), { recursive: true });
  writeFileSync(join(storageDirPath, 'sessions-db-pending', '.promoter'),
    `${new Date().toISOString()}\n`);
}

/**
 * Temp workspace with the "Druumen Workspace" sentinel + a real git repo, and
 * (by default) a promoter marker in the legacy `tickets/_logs/` storage dir —
 * i.e. a machine with both hooks wired up. Pass `withPromoter: false` to
 * simulate a half-installed machine.
 */
function makeFakeWorkspace(opts = {}) {
  const dir = mkTmp(opts.prefix || 'prompt-ws-');
  if (opts.withClaude !== false) {
    writeFileSync(join(dir, 'CLAUDE.md'),
      '# CLAUDE.md\n\nThis is a Druumen Workspace test fixture.\n');
  }
  if (opts.withPromoter !== false) {
    plantPromoterMarker(join(dir, 'tickets', '_logs'));
  }
  if (opts.withGit !== false) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const run = (args) => {
      const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
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
 * Transcript fixture. `firstPrompt: null` produces a transcript with NO human
 * message, which is how we simulate "the session exists but nobody has typed"
 * for the deferral tests.
 */
function makeFakeTranscript(dir, sessionId, opts = {}) {
  const transcriptPath = join(dir, `${sessionId}.jsonl`);
  const lines = [];
  if (opts.firstPrompt !== null) {
    lines.push(JSON.stringify({
      type: 'user',
      uuid: opts.firstUuid || '11111111-1111-1111-1111-111111111111',
      parentUuid: opts.firstParentUuid || null,
      sessionId,
      cwd: dir,
      gitBranch: 'main',
      userType: 'external',
      message: { role: 'user', content: opts.firstPrompt || 'hello world from fixture' },
    }));
  }
  lines.push(JSON.stringify({
    type: 'assistant',
    uuid: opts.lastUuid || '22222222-2222-2222-2222-222222222222',
    parentUuid: opts.firstUuid || '11111111-1111-1111-1111-111111111111',
    sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
  }));
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

function runScript(script, { cwd, stdin, env = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hook hung > ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const runPromptHook = (opts) => runScript(PROMPT_HOOK, opts);
const runStartHook = (opts) => runScript(START_HOOK, opts);

/** A session id used only for the handshake test; never asserted on. */
const PRIME_SID = 'ffffffff-9999-9999-9999-999999999999';

const logsDir = (ws) => join(ws, 'tickets', '_logs');
const eventsPath = (ws) => join(logsDir(ws), 'sessions-db-events.jsonl');
const projectionPath = (ws) => join(logsDir(ws), 'sessions-db.json');
const pendingDirOf = (ws) => join(logsDir(ws), 'sessions-db-pending');

function readEvents(ws) {
  const p = eventsPath(ws);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((l) => JSON.parse(l));
}

function readSessions(ws) {
  return JSON.parse(readFileSync(projectionPath(ws), 'utf8')).sessions;
}

function onlySession(ws) {
  const sessions = readSessions(ws);
  const ids = Object.keys(sessions);
  assert.equal(ids.length, 1, `expected exactly one session, got ${ids.length}`);
  return sessions[ids[0]];
}

// ---------------------------------------------------------------------------

describe('SessionStart deferral (ghost prevention)', () => {
  // The whole point of the change: a Claude Code process that comes up and is
  // never spoken to must leave NOTHING in the database. Warm-pool spawns and
  // IDE panel processes produced 11 of 13 records on one measured day.
  it('a session with no transcript and no prior record writes NO event', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-noop-' });
    try {
      const r = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stderr, '');
      assert.equal(existsSync(eventsPath(ws)), false,
        'a never-used session must not append any event');
      assert.equal(existsSync(projectionPath(ws)), false,
        'a never-used session must not create a projection record');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('the deferred session is staged in the pending area instead', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-staged-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, source: 'startup' }),
        env: { HOME: ws },
      });
      const staged = join(pendingDirOf(ws), `${FAKE_SID}.json`);
      assert.equal(existsSync(staged), true, 'pending record should exist');
      const record = JSON.parse(readFileSync(staged, 'utf8'));
      assert.equal(record.claude_session_id, FAKE_SID);
      assert.equal(record.source, 'startup');
      // The staged record carries the session-start git context so the later
      // promotion can reproduce the session_seen SessionStart would have
      // written — that is what keeps `branch_at_start` meaningful.
      assert.equal(record.branch_at_start, 'main');
      assert.ok(/^[0-9a-f]{40}$/.test(record.head_at_start));
      assert.equal(record.cwd, ws);
      assert.ok(record.observed_at, 'observed_at is what preserves created_at on promotion');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The fail-safe. Deferral is only sound if something will later promote what
  // was deferred, and the two hooks are registered independently. A machine
  // that has SessionStart but NOT UserPromptSubmit must keep the pre-0.2.0
  // always-record behaviour: ghosts come back, but no session is ever lost.
  // Losing sessions silently would be strictly worse than the problem being
  // solved, so "cannot prove a promoter exists" has to mean "do not defer".
  it('does NOT defer when no promoter has ever run (half-installed machine)', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-no-promoter-', withPromoter: false });
    try {
      const r = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const events = readEvents(ws);
      assert.equal(events.length, 1,
        'with no promoter registered the hook must record eagerly, not defer into a void');
      assert.equal(events[0].op, 'session_seen');
      assert.equal(existsSync(join(pendingDirOf(ws), `${FAKE_SID}.json`)), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The other direction, exercising the real handshake rather than a planted
  // file: running the prompt hook once is what tells SessionStart it is safe to
  // start deferring.
  it('a single real prompt-hook run flips SessionStart into deferring', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-handshake-', withPromoter: false });
    try {
      // A prompt for a session nobody recorded: the hook records it (see the
      // "unknown session IS recorded" test) and, either way, leaves its
      // marker — the marker is written before any decision about what to
      // write, precisely so that even an ignored prompt proves the hook runs.
      const primed = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: PRIME_SID, cwd: ws, prompt: 'priming run' }),
        env: { HOME: ws },
      });
      assert.equal(primed.code, 0, `stderr: ${primed.stderr}`);
      assert.equal(existsSync(join(pendingDirOf(ws), '.promoter')), true,
        'the prompt hook must announce itself so SessionStart can trust deferral');
      const afterPriming = readEvents(ws).length;

      const r = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(readEvents(ws).length, afterPriming,
        'now that a promoter exists, the new session is deferred, not recorded');
      assert.equal(existsSync(join(pendingDirOf(ws), `${FAKE_SID}.json`)), true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Invariant-false side: deferral must NOT swallow real sessions. A resume /
  // compact arrives with a transcript that already contains a human prompt,
  // and that is positive evidence the session is real.
  it('does NOT defer when the transcript already contains a human prompt', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-real-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      const r = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, transcript_path: transcriptPath }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const events = readEvents(ws);
      assert.equal(events.length >= 1, true, 'a session with real content must be recorded');
      assert.equal(events[0].op, 'session_seen');
      assert.equal(existsSync(join(pendingDirOf(ws), `${FAKE_SID}.json`)), false,
        'a recorded session must not also be staged');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Invariant-false side #2: the second acceptance signal. Once a session is
  // in the projection, a later SessionStart (resume with a transcript that has
  // not been flushed yet) must still refresh it rather than being deferred —
  // otherwise every resume would lose its branch/HEAD refresh.
  it('does NOT defer when the claude_session_id is already recorded', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-known-' });
    try {
      // First: record it for real via a transcript with content.
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID);
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, transcript_path: transcriptPath }),
        env: { HOME: ws },
      });
      const before = readEvents(ws).length;

      // Second: same csid, but NO transcript path at all. Known csid wins.
      rmSync(transcriptPath, { force: true });
      const r = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.ok(readEvents(ws).length > before,
        'a known session must still be observed, not deferred');
      assert.equal(existsSync(join(pendingDirOf(ws), `${FAKE_SID}.json`)), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Invariant-false side of deferral: staging is a PROMISE that something
  // will promote later. When the staging write fails, that promise is void —
  // nothing is on disk to promote and nothing has been recorded, so the
  // session disappears. `writePending` swallows its own errors by contract
  // (full disk, read-only FS, EPERM), so the return value is the only signal
  // that this happened, and ignoring it made every one of those cases a
  // silently lost session.
  it('records eagerly when the pending record cannot be written', async () => {
    const ws = makeFakeWorkspace({ prefix: 'defer-staging-fails-' });
    try {
      // Occupy the destination path with a directory: the tmp write succeeds,
      // the rename onto it fails, writePending returns false. Chosen over a
      // chmod because it behaves identically for root (CI containers).
      mkdirSync(join(pendingDirOf(ws), `${FAKE_SID}.json`), { recursive: true });

      const r = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const events = readEvents(ws);
      assert.equal(events.length, 1,
        'a failed staging must fall back to recording, not vanish');
      assert.equal(events[0].op, 'session_seen');
      assert.equal(events[0].payload.claude_session_id, FAKE_SID);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('UserPromptSubmit hook — safety contract', () => {
  // Contract 5: kill switch, checked before any import.
  it('contract-5 kill switch: DRUUMEN_SESSIONS_DB_DISABLED=1 exits 0 and writes nothing', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-killswitch-' });
    try {
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { DRUUMEN_SESSIONS_DB_DISABLED: '1', HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.equal(existsSync(eventsPath(ws)), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The kill switch has to win even when the main module cannot be imported,
  // which is only true if it short-circuits BEFORE the dynamic import.
  it('contract-5 kill switch short-circuits before importing main', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-killswitch-boot-' });
    const moved = `${PROMPT_HOOK_MAIN}.MOVED-FOR-TEST`;
    try {
      renameSync(PROMPT_HOOK_MAIN, moved);
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { DRUUMEN_SESSIONS_DB_DISABLED: '1', HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '',
        `kill-switch path must not leak the import error; got: ${r.stderr}`);
    } finally {
      if (existsSync(moved)) renameSync(moved, PROMPT_HOOK_MAIN);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Contract 1: cwd-gate. A repo that never opted in must be invisible to us.
  it('contract-1 cwd-gate: non-druumen cwd exits 0 without writing', async () => {
    const ws = mkTmp('prompt-non-druumen-');
    try {
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.equal(existsSync(eventsPath(ws)), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Contract 4: exit 0 on every path, including garbage input.
  it('contract-4 always exit 0: malformed stdin is silent', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-bad-stdin-' });
    try {
      const r = await runPromptHook({ cwd: ws, stdin: '{{{not json', env: { HOME: ws } });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('contract-4 always exit 0: corrupted projection does not break the hook', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-bad-projection-' });
    try {
      mkdirSync(logsDir(ws), { recursive: true });
      writeFileSync(projectionPath(ws), '{ corrupted not json }');
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('non-uuid session_id is rejected before any write', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-bad-sid-' });
    try {
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: 'not-a-uuid', cwd: ws, prompt: 'hello' }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.equal(existsSync(eventsPath(ws)), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Contract 3: silent stderr — enforced on both files of the hook.
  it('contract-3 silent stderr: hook sources contain no console.error / console.warn calls', () => {
    for (const file of [PROMPT_HOOK, PROMPT_HOOK_MAIN]) {
      const src = readFileSync(file, 'utf8');
      assert.equal(/console\.error\s*\(/.test(src), false, `${file} must not call console.error`);
      assert.equal(/console\.warn\s*\(/.test(src), false, `${file} must not call console.warn`);
    }
  });

  // Contract 3 under adversarial conditions: a git binary that screams on
  // stderr must not leak through us into the user's terminal mid-prompt.
  it('contract-3 silent stderr: a failing git binary does not leak', async () => {
    if (process.platform === 'win32') return; // shebang shim is POSIX-only
    const fakeGitDir = mkTmp('prompt-fake-git-fail-');
    writeFileSync(join(fakeGitDir, 'git'),
      "#!/bin/sh\nprintf '%s\\n' 'fatal: simulated git failure' 1>&2\nexit 128\n");
    spawnSync('chmod', ['755', join(fakeGitDir, 'git')]);
    const ws = makeFakeWorkspace({ prefix: 'prompt-failing-git-', withGit: false });
    try {
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { HOME: ws, PATH: `${fakeGitDir}${delimiter}${process.env.PATH}` },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '', `leaked: ${r.stderr}`);
    } finally {
      rmSync(fakeGitDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Contract 2: the hard timeout must actually fire. A hung `git` used to be
  // survivable only because probes were sync; with async spawn the bootstrap
  // timer wins. 1000 ms ceiling here (half of SessionStart's) because this
  // hook sits on the user's per-turn latency path.
  it('contract-2 timeout: a permanently hung git cannot exceed the 1s ceiling', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows: shebang fake-git unsupported; contract verified on POSIX CI');
      return;
    }
    const fakeGitDir = mkTmp('prompt-fake-git-hang-');
    writeFileSync(join(fakeGitDir, 'git'), '#!/bin/sh\nexec sleep 30\n');
    spawnSync('chmod', ['755', join(fakeGitDir, 'git')]);
    const ws = makeFakeWorkspace({ prefix: 'prompt-hung-git-', withGit: false });
    try {
      const start = Date.now();
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { HOME: ws, PATH: `${fakeGitDir}${delimiter}${process.env.PATH}` },
        timeoutMs: 3000,
      });
      const elapsed = Date.now() - start;
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      // The git probe's own 400 ms budget should end it well before the 1s
      // bootstrap ceiling; either way it must not approach SessionStart's 2s.
      assert.ok(elapsed < 1500, `hung git took ${elapsed}ms, expected < 1500ms`);
    } finally {
      rmSync(fakeGitDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Storage anchoring when git is unavailable.
  //
  // `gitContextFast` collapses EVERY non-zero git exit into `not_a_repo` +
  // `worktreePath: null` — and "non-zero" covers much more than "outside a
  // repo". `fatal: detected dubious ownership` is the realistic one: shared
  // checkouts, containers, dev-offload mounts. SessionStart bails on
  // not_a_repo, so if this hook instead falls back to `workspaceRoot = cwd`
  // the two hooks pick different databases — and the one this hook picks is
  // whatever subdirectory the user happened to be in, which it then CREATES.
  // -------------------------------------------------------------------------
  it('does not create a database in a subdirectory when git fails', async () => {
    if (process.platform === 'win32') return; // shebang shim is POSIX-only
    const fakeGitDir = mkTmp('prompt-fake-git-dubious-');
    writeFileSync(join(fakeGitDir, 'git'),
      "#!/bin/sh\nprintf '%s\\n' 'fatal: detected dubious ownership in repository' 1>&2\nexit 128\n");
    spawnSync('chmod', ['755', join(fakeGitDir, 'git')]);
    const ws = makeFakeWorkspace({ prefix: 'prompt-git-dubious-', withGit: false });
    const deep = join(ws, 'packages', 'deep', 'app');
    mkdirSync(deep, { recursive: true });
    try {
      const r = await runPromptHook({
        cwd: deep,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: deep, prompt: 'hello' }),
        env: { HOME: ws, PATH: `${fakeGitDir}${delimiter}${process.env.PATH}` },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(existsSync(join(deep, 'tickets')), false,
        'no storage tree may be created inside the user\'s repo');
      assert.equal(existsSync(join(deep, '.dru-code')), false);
    } finally {
      rmSync(fakeGitDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // ...but bailing must be conditional on "this is not a storage root", not
  // on "git failed" — a workspace that already holds the database is a valid
  // anchor with or without git, and refusing there would drop heartbeats for
  // everyone on a wedged repo.
  it('still writes when git fails but the cwd IS already a storage root', async () => {
    if (process.platform === 'win32') return;
    const fakeGitDir = mkTmp('prompt-fake-git-dubious2-');
    writeFileSync(join(fakeGitDir, 'git'),
      "#!/bin/sh\nprintf '%s\\n' 'fatal: detected dubious ownership in repository' 1>&2\nexit 128\n");
    spawnSync('chmod', ['755', join(fakeGitDir, 'git')]);
    const ws = makeFakeWorkspace({ prefix: 'prompt-git-dubious-anchored-', withGit: false });
    try {
      // An initialized database at the cwd itself — what `sessions-db init`
      // or the cockpit Setup Wizard leaves behind.
      mkdirSync(logsDir(ws), { recursive: true });
      writeFileSync(projectionPath(ws), JSON.stringify({
        _meta: { schema_version: 2, event_count: 0, last_event_id: null, updated: null },
        sessions: {},
      }));

      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'hello' }),
        env: { HOME: ws, PATH: `${fakeGitDir}${delimiter}${process.env.PATH}` },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(existsSync(join(pendingDirOf(ws), '.promoter')), true,
        'the hook must still run against an established storage root');
    } finally {
      rmSync(fakeGitDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('UserPromptSubmit hook — promotion and heartbeat', () => {
  // The headline behaviour: SessionStart defers, the first prompt promotes,
  // and the record that appears has the preview SessionStart could never know.
  it('first prompt promotes the pending session into a real record', async () => {
    const ws = makeFakeWorkspace({ prefix: 'promote-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(existsSync(eventsPath(ws)), false, 'precondition: nothing recorded yet');

      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          prompt: 'help me fix the RLS regression',
        }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stderr, '');

      const events = readEvents(ws);
      assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
      assert.equal(events[0].op, 'session_seen');
      assert.equal(events[0].payload.promoted_from_pending, true);

      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, 'help me fix the RLS regression');
      assert.deepEqual(session.claude_session_ids, [FAKE_SID]);
      assert.equal(session.branch_at_start, 'main');
      assert.equal(session.branch_current, 'main');
      // The prompt fingerprint is what lets identity reconciliation (and
      // prune's "this was a real conversation" test) work without a transcript.
      assert.ok(session.fingerprints.first_human_prompt_v1,
        'promotion must compute first_human_prompt_v1 from the prompt itself');

      // The staged file is consumed once the event is durable.
      assert.equal(existsSync(join(pendingDirOf(ws), `${FAKE_SID}.json`)), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // created_at must date from process start, not from the first prompt —
  // otherwise the pending design would silently corrupt session ages.
  it('promotion preserves created_at from the deferred SessionStart', async () => {
    const ws = makeFakeWorkspace({ prefix: 'promote-createdat-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      const staged = JSON.parse(
        readFileSync(join(pendingDirOf(ws), `${FAKE_SID}.json`), 'utf8'),
      );

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'first thing i said' }),
        env: { HOME: ws },
      });

      const session = onlySession(ws);
      assert.equal(session.created_at, staged.observed_at,
        'created_at must be the deferred observation time, not the promoting event ts');
      const events = readEvents(ws);
      assert.ok(events[0].ts >= staged.observed_at,
        'the event itself is still stamped now — only created_at is replayed');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The reason first_prompt_preview is first-write-wins: without it a session
  // would end up titled by whatever the user last typed ("ok", "continue").
  it('later prompts do NOT overwrite first_prompt_preview', async () => {
    const ws = makeFakeWorkspace({ prefix: 'heartbeat-preview-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'the original question' }),
        env: { HOME: ws },
      });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'ok' }),
        env: { HOME: ws },
      });

      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, 'the original question');

      const events = readEvents(ws);
      assert.equal(events.length, 2);
      assert.equal(events[1].op, 'session_progress');
      // ...and the later prompt is not even written to the log. The reducer
      // discards it (first-write-wins), so sending it achieved nothing except
      // persisting a 200-char excerpt of EVERY prompt into an append-only
      // file. The writer now skips it whenever the record already has one;
      // the case that still needs it is covered by the next test.
      assert.equal(events[1].payload.first_prompt_preview, null,
        'a record that already has a preview must not get another one logged');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The other side of that suppression: a record with NO preview must still
  // get one from the next prompt. Sessions recorded before this hook existed
  // (and any whose projection write failed) live in exactly that state, and
  // they are the reason the payload field exists at all.
  it('a record with no preview yet still gets one — exactly once', async () => {
    // withPromoter:false makes SessionStart record eagerly, and with no
    // transcript there is no preview to record: a pre-0.2.0-shaped row.
    const ws = makeFakeWorkspace({ prefix: 'heartbeat-preview-backfill-', withPromoter: false });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(onlySession(ws).first_prompt_preview, null);

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'backfilled question' }),
        env: { HOME: ws },
      });
      assert.equal(onlySession(ws).first_prompt_preview, 'backfilled question');

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'and a second turn' }),
        env: { HOME: ws },
      });

      const events = readEvents(ws);
      const progress = events.filter((e) => e.op === 'session_progress');
      assert.equal(progress.length, 2);
      assert.equal(progress[0].payload.first_prompt_preview, 'backfilled question');
      assert.equal(progress[1].payload.first_prompt_preview, null);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The defect that made the cockpit list sort by "who got resumed" instead of
  // "who is working": last_progress_at was frozen at created_at forever.
  it('each prompt advances last_progress_at', async () => {
    const ws = makeFakeWorkspace({ prefix: 'heartbeat-progress-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'one' }),
        env: { HOME: ws },
      });
      const first = onlySession(ws).last_progress_at;

      await new Promise((r) => setTimeout(r, 15));
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'two' }),
        env: { HOME: ws },
      });
      const second = onlySession(ws).last_progress_at;

      assert.ok(second > first,
        `last_progress_at must advance on every prompt (${first} -> ${second})`);
      assert.ok(second > onlySession(ws).created_at,
        'progress must move past created_at — that freeze was the original bug');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // branch_current is the other field that genuinely drifts mid-session; it is
  // why the hook pays for a git probe at all.
  it('branch_current follows a mid-session branch switch (branch_at_start does not)', async () => {
    const ws = makeFakeWorkspace({ prefix: 'heartbeat-branch-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'start on main' }),
        env: { HOME: ws },
      });
      assert.equal(onlySession(ws).branch_current, 'main');

      spawnSync('git', ['checkout', '-q', '-b', 'feat/mid-session'], { cwd: ws });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'now on a branch' }),
        env: { HOME: ws },
      });

      const session = onlySession(ws);
      assert.equal(session.branch_current, 'feat/mid-session');
      assert.equal(session.branch_at_start, 'main',
        'branch_at_start is first-write-wins and must survive the switch');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Losing the pending record must not lose the session.
  //
  // `lib/pending.mjs` promises twice over that a pending file is disposable:
  // its design note says a lost one "degrades to exactly the pre-existing
  // behaviour (the session gets recorded on its first prompt, with created_at
  // set to that moment)", and PENDING_MAX_AGE_MS justifies a 24 h GC on that
  // same basis. Both promises live or die by this hook recording a session it
  // cannot find. It used to exit instead — and since the pending file stays
  // gone, EVERY later prompt of that session exited too, so the session was
  // never recorded anywhere. The three tests below are the three ways in.
  // -------------------------------------------------------------------------

  it('a prompt for an unknown session IS recorded (nothing staged, nothing known)', async () => {
    const ws = makeFakeWorkspace({ prefix: 'heartbeat-unknown-' });
    try {
      // No SessionStart ran, so there is neither a record nor a pending file.
      // The cwd-gate has already established this workspace is tracked, and
      // `recordSessionSeen` resolves any race with SessionStart under the
      // projection lock, so "we have never heard of this session" is not a
      // reason to drop a human prompt on the floor.
      const r = await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'orphan prompt' }),
        env: { HOME: ws },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const events = readEvents(ws);
      assert.equal(events.length, 1, 'the session must be recorded, not dropped');
      assert.equal(events[0].op, 'session_seen');
      assert.equal(events[0].payload.minted_from_prompt, true,
        'the log should say which path produced the record');

      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, 'orphan prompt');
      assert.ok(session.fingerprints.first_human_prompt_v1,
        'the fingerprint is what keeps prune from treating this record as a ghost');
      assert.deepEqual(session.claude_session_ids, [FAKE_SID]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('the pending file being deleted does not lose the session', async () => {
    const ws = makeFakeWorkspace({ prefix: 'pending-deleted-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      const staged = join(pendingDirOf(ws), `${FAKE_SID}.json`);
      assert.equal(existsSync(staged), true);
      // Anything can do this: a cleaner, a user tidying the storage dir, a
      // sync tool, `writePending` having silently failed in the first place.
      rmSync(staged);

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'still working here' }),
        env: { HOME: ws },
      });

      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, 'still working here');
      // The documented degradation, and the only one: created_at is the first
      // prompt rather than session start, because the observation that knew
      // the start time is exactly what went missing.
      assert.ok(session.created_at, 'created_at falls back to now');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a pending record GC-d after 24h does not lose the session', async () => {
    // "Leave the tab open on Friday, type on Monday". sweepPending reclaims
    // the staged record at PENDING_MAX_AGE_MS and the next prompt arrives to
    // find nothing staged — which is precisely the state the GC's own
    // rationale assumes is harmless.
    const ws = makeFakeWorkspace({ prefix: 'pending-gcd-' });
    const OTHER_SID = 'bbbbbbbb-1111-2222-3333-444444444444';
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      const staged = join(pendingDirOf(ws), `${FAKE_SID}.json`);
      assert.equal(existsSync(staged), true);

      // Age it past PENDING_MAX_AGE_MS, then trigger the real GC the way
      // production does — another SessionStart deferral.
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(staged, old, old);
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: OTHER_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(existsSync(staged), false, 'sweepPending should have reclaimed it');

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'monday morning' }),
        env: { HOME: ws },
      });

      const sessions = readSessions(ws);
      const ids = Object.keys(sessions);
      assert.equal(ids.length, 1, 'the typed-into session must exist; the other must not');
      assert.equal(sessions[ids[0]].first_prompt_preview, 'monday morning');
      assert.deepEqual(sessions[ids[0]].claude_session_ids, [FAKE_SID]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // A session recorded the old way (transcript with content at SessionStart)
  // still gets heartbeats — the two paths have to coexist during the upgrade.
  it('heartbeats a session that was recorded by SessionStart directly', async () => {
    const ws = makeFakeWorkspace({ prefix: 'heartbeat-existing-' });
    try {
      const transcriptPath = makeFakeTranscript(ws, FAKE_SID, { firstPrompt: 'from transcript' });
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, transcript_path: transcriptPath }),
        env: { HOME: ws },
      });
      const before = readEvents(ws).length;

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'a later turn' }),
        env: { HOME: ws },
      });

      const events = readEvents(ws);
      assert.equal(events.length, before + 1);
      assert.equal(events[events.length - 1].op, 'session_progress');
      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, 'from transcript',
        'the transcript-derived preview wins — it is the earlier observation');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Privacy opt-out parity with SessionStart: preview suppressed, fingerprint
  // retained. Dropping the fingerprint too would make opt-out users' real
  // sessions indistinguishable from ghosts and hand them to prune.
  it('privacy: STORE_PREVIEW=0 suppresses the preview but keeps the fingerprint', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-privacy-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'secret prompt text' }),
        env: { HOME: ws, DRUUMEN_SESSIONS_DB_STORE_PREVIEW: '0' },
      });

      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, null);
      assert.ok(session.fingerprints.first_human_prompt_v1,
        'fingerprint must survive the opt-out — prune treats it as proof of a real session');
      const events = readEvents(ws);
      assert.equal(
        JSON.stringify(events).includes('secret prompt text'), false,
        'the raw prompt must not appear anywhere in events.jsonl under opt-out',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The storage-target resolver is shared between the two hooks precisely so
  // that this cannot break: if they disagreed, promotion would never find the
  // pending record and every session would look brand new on its first prompt.
  it('SessionStart and UserPromptSubmit agree on the .dru-code/ storage target', async () => {
    // No CLAUDE.md — this workspace opts in purely via the `.dru-code/` marker,
    // and both the storage AND the promoter marker must live there. Planting
    // the promoter under `tickets/_logs/` instead would leave SessionStart
    // unable to see it, so the default fixture marker is suppressed here.
    const ws = makeFakeWorkspace({
      prefix: 'prompt-drucode-',
      withClaude: false,
      withPromoter: false,
    });
    try {
      mkdirSync(join(ws, '.dru-code'), { recursive: true });
      plantPromoterMarker(join(ws, '.dru-code'));
      writeFileSync(join(ws, '.dru-code', 'sessions-db.json'), JSON.stringify({
        _meta: {
          schema_version: 2,
          fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
          updated: new Date().toISOString(),
          event_count: 0,
          last_event_id: null,
        },
        sessions: {},
      }));

      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      assert.equal(existsSync(join(ws, '.dru-code', 'sessions-db-pending', `${FAKE_SID}.json`)),
        true, 'pending must be staged under .dru-code/, beside the projection');

      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws, prompt: 'dru-code prompt' }),
        env: { HOME: ws },
      });

      const projection = JSON.parse(
        readFileSync(join(ws, '.dru-code', 'sessions-db.json'), 'utf8'),
      );
      const sessions = Object.values(projection.sessions);
      assert.equal(sessions.length, 1, 'promotion must land in the same .dru-code/ store');
      assert.equal(sessions[0].first_prompt_preview, 'dru-code prompt');
      assert.equal(existsSync(join(ws, 'tickets', '_logs')), false,
        'neither hook may create a parallel tickets/_logs/ store');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Prompt text goes through the same sanitizer as transcript-derived
  // previews, so IDE/system wrappers cannot leak file paths into the preview.
  it('prompt text is sanitized before persistence', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-sanitize-' });
    try {
      await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: FAKE_SID, cwd: ws }),
        env: { HOME: ws },
      });
      await runPromptHook({
        cwd: ws,
        stdin: JSON.stringify({
          session_id: FAKE_SID,
          cwd: ws,
          prompt: '<system-reminder>/secret/path/leak.txt</system-reminder>real question',
        }),
        env: { HOME: ws },
      });

      const session = onlySession(ws);
      assert.equal(session.first_prompt_preview, 'real question');
      assert.equal(session.first_prompt_preview.includes('secret'), false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/**
 * Name harvesting from the PROMPT hook.
 *
 * Until this change, names were collected only at SessionStart — the one
 * moment a session has nothing to collect, because Claude Code generates
 * `ai-title` after the first exchange. The consequence was structural, not
 * flaky: a session that is never resumed never gets a name in the database,
 * measured at 289 of 688 records (42%) on the reference machine while their
 * transcripts on disk carried a title.
 *
 * Every test here therefore runs the prompt hook with NO SessionStart run in
 * between — that absence is the assertion. If a name event appears, only this
 * hook can have written it.
 */
describe('UserPromptSubmit hook — name harvesting', () => {
  const HARVEST_SID = '77777777-aaaa-bbbb-cccc-777777777777';

  function appendRecord(transcriptPath, record) {
    writeFileSync(transcriptPath, readFileSync(transcriptPath, 'utf8') + JSON.stringify(record) + '\n');
  }

  const appendAiTitle = (transcriptPath, aiTitle, sessionId = HARVEST_SID) =>
    appendRecord(transcriptPath, { type: 'ai-title', aiTitle, sessionId });

  const nameEvents = (ws) => readEvents(ws).filter((e) => e.op === 'name_set');

  const prompt = (ws, transcriptPath, text, sid = HARVEST_SID) => runPromptHook({
    cwd: ws,
    stdin: JSON.stringify({
      session_id: sid,
      cwd: ws,
      prompt: text,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    }),
    env: { HOME: ws },
  });

  it('a title generated mid-session reaches the db on the next prompt, with no resume', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-harvest-' });
    try {
      const transcript = makeFakeTranscript(ws, HARVEST_SID);

      // Turn 1: the record is created and there is genuinely nothing to
      // harvest yet. This zero is a control for the assertion below — it
      // proves the event that appears later comes from the title we append,
      // not from anything the fixture already contained.
      const first = await prompt(ws, transcript, 'first question');
      assert.equal(first.code, 0, `stderr: ${first.stderr}`);
      assert.equal(nameEvents(ws).length, 0, 'nothing to harvest before Claude Code names the session');
      assert.equal(onlySession(ws).display_name_channel, 'first_prompt');

      // Claude Code names the session — this is what it does after the first
      // exchange, i.e. always after SessionStart has already run.
      appendAiTitle(transcript, 'Session id 查询 title 命令');

      const second = await prompt(ws, transcript, 'second question');
      assert.equal(second.code, 0, `stderr: ${second.stderr}`);
      assert.equal(second.stderr, '');

      const session = onlySession(ws);
      assert.equal(session.display_name, 'Session id 查询 title 命令');
      assert.equal(session.display_name_channel, 'cc_ai_title');

      const evs = nameEvents(ws);
      assert.equal(evs.length, 1, 'exactly one name_set, written by the prompt hook');
      assert.equal(evs[0].payload.channel, 'cc_ai_title');
      assert.equal(evs[0].payload.source, 'llm');
      assert.equal(evs[0].payload.observed_from, transcript, 'provenance points at the harvested file');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Differential: the harvest must read the transcript the PAYLOAD names. A
  // hook that went looking for transcripts on its own would pass the test
  // above and this one would still be green with the harvest deleted, so the
  // two together pin the mechanism rather than the outcome.
  it('harvests nothing when the payload carries no transcript_path', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-harvest-nopath-' });
    try {
      const transcript = makeFakeTranscript(ws, HARVEST_SID);
      await prompt(ws, transcript, 'first question');
      appendAiTitle(transcript, 'a title nobody points us at');

      // Same title on disk, same session — only the payload field is gone.
      const r = await prompt(ws, null, 'second question');
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(nameEvents(ws).length, 0);
      assert.equal(onlySession(ws).display_name_channel, 'first_prompt');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Firing on every turn is the whole point, so the suppression that used to
  // face one call per session start now faces one per prompt. If it stopped
  // working the log would grow by an event per turn — invisible in any
  // single-run test, which is why this one runs four turns.
  it('re-asserting the same title on every turn appends nothing; a real rename lands', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-harvest-idem-' });
    try {
      const transcript = makeFakeTranscript(ws, HARVEST_SID);
      await prompt(ws, transcript, 'turn 1');
      appendAiTitle(transcript, 'Original title');
      await prompt(ws, transcript, 'turn 2');
      assert.equal(nameEvents(ws).length, 1);

      // Claude Code re-emits the SAME ai-title record every few KB.
      appendAiTitle(transcript, 'Original title');
      await prompt(ws, transcript, 'turn 3');
      await prompt(ws, transcript, 'turn 4');
      assert.equal(nameEvents(ws).length, 1, 'unchanged name must not append per turn');

      // A genuine rename is a change and must land.
      appendAiTitle(transcript, 'Renamed halfway through');
      await prompt(ws, transcript, 'turn 5');
      const evs = nameEvents(ws);
      assert.equal(evs.length, 2);
      assert.equal(evs[1].payload.value, 'Renamed halfway through');
      assert.equal(onlySession(ws).display_name, 'Renamed halfway through');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The mint path: no pending record and no prior record, which is how a
  // RESUMED session arrives after `sweepPending` reclaimed its staged record
  // (documented at 24 h). That transcript already carries a name, so the
  // harvest has to run on the id the mint just produced — not wait a turn.
  it('mints and harvests in the same run when the record was lost but the transcript has a name', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-harvest-mint-' });
    try {
      const transcript = makeFakeTranscript(ws, HARVEST_SID);
      appendAiTitle(transcript, 'Resumed session keeps its name');

      const r = await prompt(ws, transcript, 'typed after the pending record expired');
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const session = onlySession(ws);
      assert.equal(session.display_name, 'Resumed session keeps its name');
      assert.equal(session.display_name_channel, 'cc_ai_title');
      const events = readEvents(ws);
      assert.equal(events[0].payload.minted_from_prompt, true, 'this is the mint path, not promotion');
      assert.equal(nameEvents(ws).length, 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // pr-link rides the same scan as the names. The assertion that matters is
  // not "it was collected" but "it was collected without a second read and
  // without a second event per turn".
  it('an MR opened mid-session lands in the db, and its re-emissions append nothing', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-harvest-pr-' });
    try {
      const transcript = makeFakeTranscript(ws, HARVEST_SID);
      await prompt(ws, transcript, 'turn 1');
      const prEvents = () => readEvents(ws).filter((e) => e.op === 'pr_link_seen');
      assert.equal(prEvents().length, 0, 'no MR yet — control for the assertion below');

      const link = (ts) => appendRecord(transcript, {
        type: 'pr-link',
        sessionId: HARVEST_SID,
        prNumber: 722,
        prUrl: 'https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/722',
        prRepository: 'druumen/cn/drummen',
        timestamp: ts,
      });

      link('2026-09-07T16:04:20.294Z');
      await prompt(ws, transcript, 'turn 2');

      const session = onlySession(ws);
      assert.deepEqual(session.pr_links, [{
        repository: 'druumen/cn/drummen',
        number: 722,
        url: 'https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/722',
        first_seen_at: '2026-09-07T16:04:20.294Z',
      }]);
      assert.equal(prEvents().length, 1);

      // Claude Code re-emits the record constantly (160 copies in one real
      // transcript). Two more turns must not add two more events.
      link('2026-09-07T16:19:11.041Z');
      await prompt(ws, transcript, 'turn 3');
      link('2026-09-07T16:21:06.763Z');
      await prompt(ws, transcript, 'turn 4');
      assert.equal(prEvents().length, 1, 'unchanged link must not append per turn');
      assert.equal(onlySession(ws).pr_links[0].first_seen_at, '2026-09-07T16:04:20.294Z',
        'and the earliest observation is still the one stored');

      // A SECOND MR is a new fact and must land.
      appendRecord(transcript, {
        type: 'pr-link', sessionId: HARVEST_SID, prNumber: 723,
        prUrl: 'https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/723',
        prRepository: 'druumen/cn/drummen', timestamp: '2026-09-07T17:00:00.000Z',
      });
      await prompt(ws, transcript, 'turn 5');
      assert.deepEqual(onlySession(ws).pr_links.map((l) => l.number), [722, 723]);
      assert.equal(prEvents().length, 2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // The promotion path. Defensive rather than everyday: a session staged by
  // SessionStart normally has no name yet when its first prompt promotes it.
  // The branch exists so that when a name IS already there the record does not
  // have to wait a turn for it, and it is covered here because an untested
  // branch in a hook is a branch nobody notices going dead.
  it('harvests on the promotion path when the staged session already has a name', async () => {
    const ws = makeFakeWorkspace({ prefix: 'prompt-harvest-promote-' });
    try {
      // No human prompt in the transcript → SessionStart stages instead of recording.
      const transcript = makeFakeTranscript(ws, HARVEST_SID, { firstPrompt: null });
      const start = await runStartHook({
        cwd: ws,
        stdin: JSON.stringify({ session_id: HARVEST_SID, cwd: ws, transcript_path: transcript }),
        env: { HOME: ws },
      });
      assert.equal(start.code, 0, `stderr: ${start.stderr}`);
      assert.equal(existsSync(join(pendingDirOf(ws), `${HARVEST_SID}.json`)), true, 'staged, not recorded');
      assert.equal(nameEvents(ws).length, 0, 'SessionStart had nothing to harvest');

      appendAiTitle(transcript, 'Named before the first prompt landed');

      const r = await prompt(ws, transcript, 'first prompt promotes the staged record');
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const events = readEvents(ws);
      assert.equal(events[0].payload.promoted_from_pending, true);
      assert.equal(nameEvents(ws).length, 1);
      assert.equal(onlySession(ws).display_name, 'Named before the first prompt landed');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
