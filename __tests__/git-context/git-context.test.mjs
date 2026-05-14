import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';

import { gitContext, runGit } from '../../lib/git-context.mjs';

/**
 * Make a tmpdir + canonicalize 8.3 short names → long names on Windows.
 * `realpathSync.native` (Node v9.2+) resolves both symlinks AND 8.3 short
 * names (e.g. `RUNNER~1` → `runneradmin`); plain `realpathSync` does NOT
 * resolve 8.3 on Windows. Use .native when available.
 */
function mkTmp(prefix = 'git-context-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return realpathSync.native ? realpathSync.native(d) : realpathSync(d);
}

/**
 * Normalize a path for cross-platform comparison.
 *
 * Different observers disagree on path form on Windows:
 *   - `mkdtempSync` returns native backslash + possibly 8.3 short name
 *   - `realpathSync.native` returns native backslash + long name
 *   - `git rev-parse --show-toplevel` returns... it depends. POSIX-style
 *     forward slash in some Git for Windows builds; native backslash in
 *     others (e.g. GitHub Actions windows-latest runners observed both
 *     across CI runs). The variability is real and documented in the
 *     Git for Windows issue tracker around `core.fscache` / `MSYS` env.
 *
 * Strategy: lowercase + replace all backslashes with forward slashes.
 * After normalization, two paths pointing at the same long-name resource
 * compare equal regardless of which observer produced them.
 *
 * NOT used as a security boundary — only for test assertions where we
 * want "same filesystem location" not "same string".
 */
function normPath(p) {
  if (typeof p !== 'string') return p;
  return p.toLowerCase().replace(/\\/g, '/');
}

function assertPathEq(actual, expected, msg) {
  assert.equal(normPath(actual), normPath(expected), msg);
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

describe('git-context.mjs', () => {
  describe('inside a normal git repo', () => {
    it('returns status=ok with branch + head + worktreePath populated', async () => {
      const dir = mkTmp();
      const head = initRepo(dir);
      try {
        const ctx = await gitContext({ cwd: dir, registryPath: '/nonexistent/registry.json' });
        assert.equal(ctx.status, 'ok', `errors: ${ctx.errors.join(' | ')}`);
        assert.equal(ctx.isInsideRepo, true);
        assert.equal(ctx.isInWorktree, false, 'main checkout should not be a linked worktree');
        assert.equal(ctx.branch, 'main');
        assert.equal(ctx.head, head.toLowerCase());
        // Path observers can disagree on separator (Windows git for windows
        // builds switch between forward/backslash output across versions/
        // configs; mkdtempSync uses native backslash). normPath canonicalizes
        // both sides for "same filesystem location" semantics.
        assertPathEq(ctx.worktreePath, dir);
        assertPathEq(ctx.worktreeRealpath, dir);
        assert.ok(
          ctx.gitCommonDir
            && (ctx.gitCommonDir.endsWith('/.git')
              || ctx.gitCommonDir.endsWith(`${sep}.git`)),
          `gitCommonDir should resolve to .git, got ${ctx.gitCommonDir}`,
        );
        assert.equal(ctx.registryName, null);
        assert.deepEqual(ctx.errors, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('outside any git repo', () => {
    it('returns status=not_a_repo with isInsideRepo=false', async () => {
      const dir = mkTmp('git-context-norepo-');
      try {
        const ctx = await gitContext({ cwd: dir, registryPath: '/nonexistent/registry.json' });
        assert.equal(ctx.status, 'not_a_repo');
        assert.equal(ctx.isInsideRepo, false);
        assert.equal(ctx.branch, null);
        assert.equal(ctx.head, null);
        assert.equal(ctx.worktreePath, null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('inside a linked git worktree', () => {
    it('reports isInWorktree=true and gitCommonDir != worktreePath/.git', async () => {
      const main = mkTmp('git-context-main-');
      initRepo(main);
      // git worktree add wants a fresh branch name; create one off main.
      const worktreeDir = mkTmp('git-context-wt-');
      // mkdtempSync already created the dir; git worktree add refuses an
      // existing dir, so remove and let git re-create.
      rmSync(worktreeDir, { recursive: true, force: true });
      const r = spawnSync(
        'git',
        ['worktree', 'add', '-b', 'feat/wt-test', worktreeDir],
        { cwd: main, encoding: 'utf8' },
      );
      assert.equal(r.status, 0, `git worktree add failed: ${r.stderr || r.stdout}`);

      try {
        const ctx = await gitContext({ cwd: worktreeDir, registryPath: '/nonexistent/registry.json' });
        assert.equal(ctx.status, 'ok', `errors: ${ctx.errors.join(' | ')}`);
        assert.equal(ctx.isInsideRepo, true);
        assert.equal(ctx.isInWorktree, true);
        assert.equal(ctx.branch, 'feat/wt-test');
        assert.ok(ctx.head && /^[0-9a-f]{40}$/.test(ctx.head));
        // gitCommonDir for a linked worktree resolves to the main repo's .git
        // dir, NOT the worktree's own .git file.
        assert.ok(ctx.gitCommonDir, 'gitCommonDir should be set');
        assert.notEqual(ctx.gitCommonDir, join(realpathSync(worktreeDir), '.git'));
      } finally {
        // Clean linked worktree first (git stores metadata in main repo).
        spawnSync('git', ['worktree', 'remove', '-f', worktreeDir], { cwd: main });
        rmSync(worktreeDir, { recursive: true, force: true });
        rmSync(main, { recursive: true, force: true });
      }
    });
  });

  describe('timeout handling', () => {
    it('does not throw and surfaces an error string when git is forced to timeout', async () => {
      const dir = mkTmp('git-context-timeout-');
      initRepo(dir);
      try {
        // 1ms is unreachable for any real git invocation — every probe will
        // ETIMEDOUT. We require the call to not throw, status to be in
        // {error, partial}, and at least one error to be recorded.
        const ctx = await gitContext({
          cwd: dir,
          timeoutMs: 1,
          registryPath: '/nonexistent/registry.json',
        });
        assert.ok(['error', 'partial'].includes(ctx.status),
          `expected error|partial under aggressive timeout, got ${ctx.status}`);
        assert.ok(ctx.errors.length > 0, 'should record at least one timeout error');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('registry reverse lookup', () => {
    it('fills registryName when the registry file maps the current worktree', async () => {
      const repoDir = mkTmp('git-context-registry-');
      initRepo(repoDir);
      const registryDir = mkTmp('git-context-registry-file-');
      const registryPath = join(registryDir, 'worktree-registry.json');
      writeFileSync(registryPath, JSON.stringify({
        version: 1,
        worktrees: {
          'my-cool-feature': {
            idx: 7,
            worktree_path: repoDir,
            branch: 'main',
          },
          'unrelated-other': {
            idx: 8,
            worktree_path: '/totally/nonexistent/path',
            branch: 'other',
          },
        },
      }));
      try {
        const ctx = await gitContext({ cwd: repoDir, registryPath });
        assert.equal(ctx.registryName, 'my-cool-feature');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(registryDir, { recursive: true, force: true });
      }
    });

    it('returns registryName=null when registry file is absent', async () => {
      const dir = mkTmp('git-context-no-reg-');
      initRepo(dir);
      try {
        const ctx = await gitContext({
          cwd: dir,
          registryPath: '/definitely/does/not/exist/registry.json',
        });
        assert.equal(ctx.registryName, null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns registryName=null when registry JSON is malformed', async () => {
      const repoDir = mkTmp('git-context-bad-reg-');
      initRepo(repoDir);
      const registryDir = mkTmp('git-context-bad-reg-file-');
      const registryPath = join(registryDir, 'worktree-registry.json');
      writeFileSync(registryPath, '{not valid json');
      try {
        const ctx = await gitContext({ cwd: repoDir, registryPath });
        assert.equal(ctx.registryName, null);
        // status should still be 'ok' (registry probe is best-effort, doesn't
        // bump status).
        assert.equal(ctx.status, 'ok', `errors: ${ctx.errors.join(' | ')}`);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(registryDir, { recursive: true, force: true });
      }
    });
  });

  // P2 round-1 codex review: the original timeout test only proved gitContext
  // didn't throw — it could not catch the spawnSync-blocks-event-loop bug
  // because spawnSync's `timeout` option uses SIGTERM internally on real git
  // (which exits fast). The new test uses a fake `git` shim that ignores
  // SIGTERM-equivalent exit signals (sleep, which runs until SIGKILL), to
  // verify our async runGit + per-call deadline truly bounds wall-clock time.
  describe('async runGit hard timeout (P2 fix)', () => {
    it('runGit resolves with timedOut=true within deadline when child hangs', async (t) => {
      // Windows skip: this test uses a `#!/bin/sh` shebang fake binary to
      // simulate a hung git. Windows has no /bin/sh and chmodSync(0o755) is
      // not executable semantics — the fake never runs; PATH falls through to
      // the real git which answers fast → timedOut=false. The production
      // logic (Promise.race vs deadline + child.kill) is platform-neutral
      // Node API and is verified on POSIX CI. Replacing with a Windows-aware
      // fake (git.cmd + ping -n 30 127.0.0.1) is post-0.1.0 hardening.
      if (process.platform === 'win32') {
        t.skip('Windows: shebang fake-git unsupported; deadline+kill contract verified on POSIX CI');
        return;
      }
      const fakeGitDir = mkTmp('git-context-fake-hang-');
      const gitPath = join(fakeGitDir, 'git');
      writeFileSync(gitPath, '#!/bin/sh\nexec sleep 30\n');
      chmodSync(gitPath, 0o755);

      // Use a custom PATH so our fake `git` resolves first. We invoke runGit
      // directly (not through gitContext) so we can isolate the timing
      // contract on a single probe.
      const ctx = { errors: [] };
      const start = Date.now();
      const oldPath = process.env.PATH;
      process.env.PATH = `${fakeGitDir}${delimiter}${oldPath}`;
      let result;
      try {
        result = await runGit(
          ['--version'],
          { cwd: fakeGitDir, deadlineAt: Date.now() + 250 },
          ctx,
        );
      } finally {
        process.env.PATH = oldPath;
        rmSync(fakeGitDir, { recursive: true, force: true });
      }
      const elapsed = Date.now() - start;

      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true,
        `expected timedOut=true; got ${JSON.stringify(result)}`);
      // The deadline was 250ms; allow up to 500ms for spawn overhead +
      // SIGTERM→SIGKILL escalation grace window. Critical: must NOT take
      // 30s (which is what `sleep 30` would do without our hard kill).
      assert.ok(elapsed < 800,
        `runGit must honor deadline; took ${elapsed}ms (expected < 800ms)`);
      assert.ok(ctx.errors.some((e) => e.includes('timed out')),
        `expected timeout error in ctx.errors; got: ${ctx.errors.join(' | ')}`);
    });
  });

  describe('detached HEAD', () => {
    it('returns branch=null when HEAD is detached', async () => {
      const dir = mkTmp('git-context-detached-');
      const head = initRepo(dir);
      const r = spawnSync('git', ['checkout', '-q', '--detach', head], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `detach failed: ${r.stderr}`);
      try {
        const ctx = await gitContext({ cwd: dir, registryPath: '/nonexistent.json' });
        assert.equal(ctx.status, 'ok');
        assert.equal(ctx.branch, null);
        assert.equal(ctx.head, head.toLowerCase());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
