import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { gitContextFast } from '../../lib/git-context.mjs';

/**
 * Make a tmpdir + canonicalize 8.3 short names -> long names on Windows.
 * `realpathSync.native` (Node v9.2+) resolves both symlinks AND 8.3 short
 * names (e.g. `RUNNER~1` -> `runneradmin`); plain `realpathSync` does NOT
 * resolve 8.3 on Windows. Use .native when available.
 */
function mkTmp(prefix = 'git-context-fast-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return realpathSync.native ? realpathSync.native(d) : realpathSync(d);
}

/**
 * Initialize a git repo in `dir` with a deterministic single commit so HEAD
 * is non-null and the branch name is `main`. We disable gpg signing and pin
 * user.* config to keep the test self-contained.
 */
function initRepo(dir) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args, cwd = dir) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (cwd=${cwd}): ${r.stderr || r.stdout}`);
    }
    return (r.stdout || '').trim();
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  run(['add', 'README.md']);
  run(['commit', '-q', '-m', 'init']);
  return run(['rev-parse', 'HEAD']);
}

/**
 * Fake `git` that writes the given message to stderr and exits non-zero.
 * Same shebang-shim trick as the hook test's makeFailingGitDir — used to
 * verify gitContextFast never leaks a misbehaving git binary's stderr.
 */
function makeFailingGitDir(stderrMessage) {
  const dir = mkTmp('git-context-fast-failgit-');
  const gitPath = join(dir, 'git');
  writeFileSync(
    gitPath,
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderrMessage)} 1>&2\nexit 128\n`,
  );
  chmodSync(gitPath, 0o755);
  return dir;
}

/**
 * Fake `git` that sleeps forever. Execs `sleep 30` so it only dies to
 * SIGKILL, not SIGTERM — the worst case for a bounded-budget probe.
 */
function makeHungGitDir() {
  const dir = mkTmp('git-context-fast-hanggit-');
  const gitPath = join(dir, 'git');
  writeFileSync(gitPath, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(gitPath, 0o755);
  return dir;
}

describe('gitContextFast', () => {
  describe('inside a normal git repo', () => {
    it('returns status=ok with worktreePath/branch/head populated', async () => {
      const dir = mkTmp();
      const head = initRepo(dir);
      try {
        const ctx = await gitContextFast({ cwd: dir });
        assert.equal(ctx.status, 'ok', `errors: ${ctx.errors.join(' | ')}`);
        assert.equal(realpathSync(ctx.worktreePath), realpathSync(dir));
        assert.equal(ctx.branch, 'main');
        assert.match(ctx.head, /^[0-9a-f]{40}$/);
        assert.equal(ctx.head, head.toLowerCase());
        assert.deepEqual(ctx.errors, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('detached HEAD', () => {
    it('returns branch=null (raw --abbrev-ref would print the literal string "HEAD")', async () => {
      // If gitContextFast stored the raw --abbrev-ref output verbatim, a
      // detached checkout would end up with branch === "HEAD" — a string
      // that looks like a plausible-but-wrong branch name. The unit under
      // test explicitly maps that literal to null; this pins the mapping.
      const dir = mkTmp('git-context-fast-detached-');
      const head = initRepo(dir);
      const r = spawnSync('git', ['checkout', '-q', '--detach', head], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `detach failed: ${r.stderr}`);
      try {
        const ctx = await gitContextFast({ cwd: dir });
        assert.equal(ctx.status, 'ok', `errors: ${ctx.errors.join(' | ')}`);
        assert.equal(ctx.branch, null);
        assert.equal(ctx.head, head.toLowerCase());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('outside any git repo', () => {
    it('returns status=not_a_repo with an EMPTY errors array', async () => {
      // The expected-failure diagnostic that runGit records for the non-zero
      // exit is noise for this case — the implementation deliberately pops
      // it so callers see a clean errors[] for the "just not a repo" path.
      const dir = mkTmp('git-context-fast-norepo-');
      try {
        const ctx = await gitContextFast({ cwd: dir });
        assert.equal(ctx.status, 'not_a_repo');
        assert.deepEqual(ctx.errors, []);
        assert.equal(ctx.worktreePath, null);
        assert.equal(ctx.branch, null);
        assert.equal(ctx.head, null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('argv order regression', () => {
    it('bare HEAD before --abbrev-ref yields a sha, not the branch name', async () => {
      const dir = mkTmp('git-context-fast-argv-');
      const head = initRepo(dir);
      try {
        const ctx = await gitContextFast({ cwd: dir });
        assert.equal(ctx.status, 'ok', `errors: ${ctx.errors.join(' | ')}`);
        assert.match(ctx.head, /^[0-9a-f]{40}$/, 'head must be a 40-hex sha');
        assert.equal(ctx.head, head.toLowerCase());
        assert.notEqual(ctx.head, ctx.branch,
          'head and branch must never collapse to the same value');

        // Falsify "argument order does not matter": --abbrev-ref applies to
        // every rev that FOLLOWS it, so putting it BEFORE both HEAD args
        // means neither one prints a sha — both print the abbreviated ref.
        // This is the exact bug the real argv order (bare HEAD first) avoids.
        const wrong = spawnSync(
          'git',
          ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', 'HEAD'],
          { cwd: dir, encoding: 'utf8' },
        );
        assert.equal(wrong.status, 0, `git rev-parse (wrong order) failed: ${wrong.stderr}`);
        const lines = wrong.stdout.trim().split('\n');
        // line 1 = toplevel, line 2 + line 3 = the two HEAD revs, BOTH
        // abbreviated (no sha anywhere) because --abbrev-ref preceded them.
        assert.equal(lines[1], lines[2],
          'wrong argv order collapses both HEAD revs to the same abbreviated ref — proves order is load-bearing');
        assert.doesNotMatch(lines[1], /^[0-9a-f]{40}$/,
          'the wrong-order second line must NOT be a sha');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('never throws + soft-fail', () => {
    it('resolves (never rejects) and writes nothing to process.stderr when git exits non-zero', async (t) => {
      // Windows skip: shebang fake-git binaries need /bin/sh; see the
      // identical skip rationale in git-context.test.mjs and the hook test.
      if (process.platform === 'win32') {
        t.skip('Windows: shebang fake-git unsupported; soft-fail contract verified on POSIX CI');
        return;
      }
      const fakeGitDir = makeFailingGitDir('fatal: simulated failure for gitContextFast test');
      const dir = mkTmp('git-context-fast-failcwd-');
      const oldPath = process.env.PATH;
      const originalWrite = process.stderr.write.bind(process.stderr);
      let leaked = '';
      process.stderr.write = (chunk) => {
        leaked += chunk;
        return true;
      };
      let ctx;
      let rejected = false;
      try {
        process.env.PATH = `${fakeGitDir}${delimiter}${oldPath}`;
        try {
          ctx = await gitContextFast({ cwd: dir });
        } catch {
          rejected = true;
        }
      } finally {
        process.stderr.write = originalWrite;
        process.env.PATH = oldPath;
        rmSync(fakeGitDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
      assert.equal(rejected, false,
        'gitContextFast must resolve, never reject, even when git exits non-zero');
      assert.equal(leaked, '',
        `gitContextFast must never write to process.stderr; leaked: ${JSON.stringify(leaked)}`);
      assert.ok(ctx && typeof ctx === 'object');
      // A single-spawn probe cannot distinguish "git itself failed" from
      // "outside a repo" the way the six-probe gitContext can (that one runs
      // a dedicated --is-inside-work-tree check first) — any non-zero exit
      // collapses to not_a_repo here, diagnostic popped just like the real
      // outside-a-repo case. Verified empirically against this exact shim.
      assert.equal(ctx.status, 'not_a_repo');
      assert.deepEqual(ctx.errors, []);
    });
  });

  describe('bounded under a hung git binary', () => {
    it('resolves within totalBudgetMs with status=error when git never returns', async (t) => {
      if (process.platform === 'win32') {
        t.skip('Windows: shebang fake-git unsupported; hard-timeout contract verified on POSIX CI');
        return;
      }
      const fakeGitDir = makeHungGitDir();
      const dir = mkTmp('git-context-fast-hangcwd-');
      const oldPath = process.env.PATH;
      const start = Date.now();
      let ctx;
      try {
        process.env.PATH = `${fakeGitDir}${delimiter}${oldPath}`;
        ctx = await gitContextFast({ cwd: dir, totalBudgetMs: 250 });
      } finally {
        process.env.PATH = oldPath;
        rmSync(fakeGitDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
      const elapsed = Date.now() - start;
      assert.equal(ctx.status, 'error');
      // 250ms deadline + up to 50ms SIGTERM->SIGKILL escalation grace window
      // + spawn overhead. Critical assertion: must NOT take anywhere near the
      // shim's `sleep 30` — that is exactly what the hard kill prevents.
      assert.ok(elapsed < 800,
        `gitContextFast must honor totalBudgetMs; took ${elapsed}ms (expected < 800ms)`);
    });
  });
});
