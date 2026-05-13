/**
 * Shared git/worktree probe for Claude Code hook scripts.
 *
 * Why a separate library: every SessionStart-class hook (sessions-db,
 * hive-watcher, future ones) needs the same triplet: (worktree path, branch,
 * HEAD) and the same survival posture — sub-second timeouts, soft-fail on
 * every probe, never throw to the caller, never blow past the hook's overall
 * 2-second budget. Centralising the probe here keeps each hook's main file
 * tiny and lets us evolve the survival rules in one place.
 *
 * Design rules (enforced by the test suite):
 *  - `runGit` uses non-blocking `child_process.spawn` + Promise.race against
 *    a single global deadline. setTimeout(...).unref() in the hook bootstrap
 *    can ACTUALLY fire because we never block the event loop with spawnSync.
 *  - Every git invocation respects the SAME absolute deadline (computed once
 *    in `gitContext` from `totalBudgetMs`), so 6 sequential probes can never
 *    add up to > totalBudgetMs even if each individual probe runs slowly.
 *    When the deadline lapses mid-sequence we skip remaining probes and
 *    surface `status: 'partial'`.
 *  - We surface a `status` of `ok` | `partial` | `not_a_repo` | `error` plus a
 *    plain `errors[]` array of one-line diagnostics. Callers can branch on
 *    `status` without touching `errors`.
 *  - The dev-offload registry probe (`~/.claude-dev/druumen-dev/
 *    worktree-registry.json`) is best-effort only — file missing / unreadable
 *    leaves `registryName === null` without raising the overall status.
 *  - Default `totalBudgetMs` is 1500 ms total; the hook script's outer 2000 ms
 *    hard timeout is the ultimate guard (and now actually fires because we're
 *    not blocking the event loop).
 *
 * Zero new npm deps: only `node:child_process`, `node:fs`, `node:os`,
 * `node:path`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_TOTAL_BUDGET_MS = 1500;
// Floor for per-probe budget — if remaining < this, we treat the deadline as
// already lapsed (avoids spawning a process that has effectively no time).
const MIN_PROBE_BUDGET_MS = 25;
const REGISTRY_PATH_DEFAULT = join(homedir(), '.claude-dev', 'druumen-dev', 'worktree-registry.json');

/**
 * @typedef {Object} GitContext
 * @property {string}      cwd                 The cwd we ran probes against (always set).
 * @property {string|null} worktreePath        Output of `git rev-parse --show-toplevel` (worktree root).
 * @property {string|null} worktreeRealpath    realpath() of worktreePath, with symlinks resolved.
 * @property {string|null} gitCommonDir        Output of `git rev-parse --git-common-dir` (resolved to absolute).
 * @property {boolean}     isInWorktree        True when worktree's `.git` is a file (linked worktree),
 *                                             i.e. gitCommonDir's parent != worktreePath.
 * @property {boolean}     isInsideRepo        True when cwd is inside any git repo (linked worktree counts).
 * @property {string|null} branch              `git branch --show-current` (empty string => detached HEAD => null).
 * @property {string|null} head                `git rev-parse HEAD` (full SHA).
 * @property {string|null} registryName        Key in the dev-offload registry whose `worktree_path` matches us.
 * @property {'ok'|'partial'|'not_a_repo'|'error'} status
 * @property {string[]}    errors              One-liner error summaries, suitable for jsonl logging.
 */

/**
 * Probe git context for `cwd`. Never throws; returns a `GitContext` whose
 * `status` field tells the caller what to trust.
 *
 * Budget model: `totalBudgetMs` is the wall-clock budget for ALL probes
 * combined. Each individual probe gets `min(remaining, MIN_PROBE_BUDGET_MS)`
 * — once the budget is exhausted, we stop probing and return whatever we
 * have so far with `status: 'partial'`.
 *
 * @param {{ cwd?: string, totalBudgetMs?: number, registryPath?: string }} [opts]
 * @returns {Promise<GitContext>}
 */
export async function gitContext(opts = {}) {
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  const totalBudgetMs = Number.isFinite(opts.totalBudgetMs) && opts.totalBudgetMs > 0
    ? opts.totalBudgetMs
    : Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      // Backward compat: old callers passed `timeoutMs` for per-call budget.
      // Treat it as the total budget so behavior is at-most-as-slow as before.
      ? opts.timeoutMs
      : DEFAULT_TOTAL_BUDGET_MS;
  const registryPath = typeof opts.registryPath === 'string' && opts.registryPath.length > 0
    ? opts.registryPath
    : REGISTRY_PATH_DEFAULT;

  const deadlineAt = Date.now() + totalBudgetMs;

  /** @type {GitContext} */
  const ctx = {
    cwd,
    worktreePath: null,
    worktreeRealpath: null,
    gitCommonDir: null,
    isInWorktree: false,
    isInsideRepo: false,
    branch: null,
    head: null,
    registryName: null,
    status: 'ok',
    errors: [],
  };

  // Probe 1: are we inside a git repo at all?
  // `git rev-parse --is-inside-work-tree` returns "true" when in a working
  // tree. Outside a repo git exits 128 with "fatal: not a git repository" on
  // stderr; that is the canonical "not_a_repo" signal and is NOT a runtime
  // error — we suppress the diagnostic that runGit recorded for it.
  const insideProbe = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, deadlineAt }, ctx);
  if ((insideProbe.stdout || '').trim() === 'true') {
    ctx.isInsideRepo = true;
  } else if (insideProbe.spawnFailed || insideProbe.timedOut) {
    // git binary missing / spawn error / timed out — distinct from "outside
    // a repo". Keep the recorded error as-is.
    ctx.status = 'error';
    return ctx;
  } else {
    // Ran fine but exit != 0: "not_a_repo". The diagnostic runGit added is
    // noise for this expected case — pop it so callers see a clean errors[].
    if (ctx.errors.length > 0) ctx.errors.pop();
    ctx.status = 'not_a_repo';
    return ctx;
  }

  // From here on, every probe is conditional on remaining budget. If the
  // deadline lapses we stop probing and finalize with status='partial'.
  const finalize = () => {
    if (ctx.errors.length > 0 && ctx.status === 'ok') {
      ctx.status = 'partial';
    }
    return ctx;
  };

  if (deadlineLapsed(deadlineAt)) {
    ctx.errors.push('git probes: total budget exhausted after probe 1');
    return finalize();
  }

  // Probe 2: worktree root.
  const topProbe = await runGit(['rev-parse', '--show-toplevel'], { cwd, deadlineAt }, ctx);
  if (topProbe.ok) {
    const top = (topProbe.stdout || '').trim();
    if (top.length > 0) {
      ctx.worktreePath = top;
      try {
        ctx.worktreeRealpath = realpathSync(top);
      } catch (err) {
        // realpath failure is non-fatal — keep worktreePath, log the issue.
        ctx.errors.push(`realpath(${truncate(top, 80)}): ${shortMessage(err)}`);
      }
    }
  }

  if (deadlineLapsed(deadlineAt)) return finalize();

  // Probe 3: git common dir (the canonical .git directory; for linked
  // worktrees this differs from worktreePath/.git). We resolve relative paths
  // against worktreePath || cwd so callers always see an absolute path.
  const commonProbe = await runGit(['rev-parse', '--git-common-dir'], { cwd, deadlineAt }, ctx);
  if (commonProbe.ok) {
    const raw = (commonProbe.stdout || '').trim();
    if (raw.length > 0) {
      const absBase = ctx.worktreePath || cwd;
      const abs = raw.startsWith('/') ? raw : resolve(absBase, raw);
      try {
        ctx.gitCommonDir = realpathSync(abs);
      } catch {
        // Couldn't realpath — keep the resolved-but-unverified absolute path
        // so callers still get a usable hint without crashing the probe.
        ctx.gitCommonDir = abs;
      }
    }
  }

  if (deadlineLapsed(deadlineAt)) return finalize();

  // Linked worktree detection: when `git rev-parse --git-dir` returns a path
  // whose realpath differs from `<worktreePath>/.git`, we know we're in a
  // linked worktree. We use git-dir (per-worktree) for this — git-common-dir
  // would always point to the main repo's .git regardless.
  if (ctx.worktreePath) {
    const gitDirProbe = await runGit(['rev-parse', '--git-dir'], { cwd, deadlineAt }, ctx);
    if (gitDirProbe.ok) {
      const raw = (gitDirProbe.stdout || '').trim();
      if (raw.length > 0) {
        const absBase = ctx.worktreePath;
        const abs = raw.startsWith('/') ? raw : resolve(absBase, raw);
        let resolvedGitDir = abs;
        try {
          resolvedGitDir = realpathSync(abs);
        } catch {
          // keep unresolved abs
        }
        // Linked worktree's git-dir lives at <commonDir>/worktrees/<name>,
        // i.e. it is NOT == <worktreePath>/.git. Compare on resolved paths.
        let mainGitDir = join(ctx.worktreePath, '.git');
        try {
          mainGitDir = realpathSync(mainGitDir);
        } catch {
          // .git might be a file in a linked worktree — keep the joined path
          // for the comparison; the inequality is still meaningful.
        }
        ctx.isInWorktree = resolvedGitDir !== mainGitDir;
      }
    }
  }

  if (deadlineLapsed(deadlineAt)) return finalize();

  // Probe 4: branch (empty stdout => detached HEAD, leave null).
  const branchProbe = await runGit(['branch', '--show-current'], { cwd, deadlineAt }, ctx);
  if (branchProbe.ok) {
    const b = (branchProbe.stdout || '').trim();
    ctx.branch = b.length > 0 ? b : null;
  }

  if (deadlineLapsed(deadlineAt)) return finalize();

  // Probe 5: HEAD SHA.
  const headProbe = await runGit(['rev-parse', 'HEAD'], { cwd, deadlineAt }, ctx);
  if (headProbe.ok) {
    const h = (headProbe.stdout || '').trim();
    if (/^[0-9a-f]{40}$/i.test(h)) {
      ctx.head = h.toLowerCase();
    }
  }

  // Probe 6 (optional): dev-offload registry reverse lookup. Only runs when
  // the file exists; missing-or-unreadable leaves registryName === null
  // without escalating ctx.status. This is a sync fs probe — no budget cost.
  ctx.registryName = lookupRegistryName(ctx.worktreeRealpath || ctx.worktreePath, registryPath);

  return finalize();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deadlineLapsed(deadlineAt) {
  return Date.now() + MIN_PROBE_BUDGET_MS > deadlineAt;
}

/**
 * Run a single `git <args>` command with a per-call budget derived from the
 * shared deadline. Uses non-blocking spawn + Promise.race so the hook's outer
 * setTimeout can actually fire (was: spawnSync blocked the event loop).
 *
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string,
 *   code: number|null, signal: NodeJS.Signals|null,
 *   spawnFailed: boolean, timedOut: boolean }>}
 */
export async function runGit(args, { cwd, deadlineAt, encoding = 'utf8' }, ctx) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= MIN_PROBE_BUDGET_MS) {
    const msg = `git ${args.join(' ')}: deadline lapsed before spawn`;
    if (ctx) ctx.errors.push(msg);
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      spawnFailed: false,
      timedOut: true,
    };
  }

  let child;
  try {
    child = spawn('git', args, {
      cwd,
      // Inherit env so credential helpers / GIT_DIR overrides behave as the
      // user expects. We pass GIT_OPTIONAL_LOCKS=0 to prevent git from
      // touching index.lock during read-only probes (cheap protection
      // against blocking on a contended worktree).
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      // Detach stdin so git never tries to read from our hook's stdin (which
      // is reserved for the JSON event payload).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = `git ${args.join(' ')}: ${shortMessage(err)}`;
    if (ctx) ctx.errors.push(msg);
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      spawnFailed: true,
      timedOut: false,
    };
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (c) => stdoutChunks.push(c));
  child.stderr.on('data', (c) => stderrChunks.push(c));

  const result = await new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    // Per-call timer races against the global deadline. We use `remaining`
    // (already computed above) as the per-call budget — every probe is
    // bounded by the shared deadline, never accumulating beyond it.
    const timer = setTimeout(() => {
      // Try graceful kill first, then SIGKILL to guarantee descent doesn't
      // outlive our budget. .unref() so the timer itself never keeps the
      // event loop alive past natural completion.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      // Hard-kill follow-up after a 50 ms grace window.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 50).unref();
      settle({ kind: 'timeout' });
    }, remaining);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ kind: 'error', err });
    });
    // Use 'close' rather than 'exit': 'exit' fires when the child has exited
    // but stdio pipes may still have buffered data not yet delivered to our
    // 'data' listeners. On a contended Linux CI runner that race lets us read
    // an empty stdout from a successful `git rev-parse --is-inside-work-tree`,
    // mis-classifying a real repo as 'not_a_repo'. 'close' fires only after
    // both the child exited AND stdio streams drained.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      settle({ kind: 'exit', code, signal });
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString(encoding);
  const stderr = Buffer.concat(stderrChunks).toString(encoding);

  if (result.kind === 'timeout') {
    const msg = `git ${args.join(' ')}: timed out after ${remaining}ms`;
    if (ctx) ctx.errors.push(msg);
    return {
      ok: false,
      stdout,
      stderr,
      code: null,
      signal: 'SIGTERM',
      spawnFailed: false,
      timedOut: true,
    };
  }

  if (result.kind === 'error') {
    const msg = `git ${args.join(' ')}: ${shortMessage(result.err)}`;
    if (ctx) ctx.errors.push(msg);
    return {
      ok: false,
      stdout,
      stderr,
      code: null,
      signal: null,
      spawnFailed: true,
      timedOut: false,
    };
  }

  // result.kind === 'exit'
  if (result.signal) {
    const msg = `git ${args.join(' ')}: killed by ${result.signal}`;
    if (ctx) ctx.errors.push(msg);
    return {
      ok: false,
      stdout,
      stderr,
      code: result.code,
      signal: result.signal,
      spawnFailed: false,
      timedOut: true,
    };
  }

  if (result.code !== 0) {
    // Non-zero exit. Some commands (rev-parse --is-inside-work-tree outside a
    // repo) intentionally exit non-zero; the caller decides whether to log it
    // by inspecting `ok`. We still record a one-line diagnostic for observers
    // — callers that consider the non-zero exit "expected" can pop the last
    // entry from ctx.errors.
    const tail = (stderr || '').trim().split('\n').pop() || `exit ${result.code}`;
    if (ctx) ctx.errors.push(`git ${args.join(' ')}: ${truncate(tail, 120)}`);
    return {
      ok: false,
      stdout,
      stderr,
      code: result.code,
      signal: null,
      spawnFailed: false,
      timedOut: false,
    };
  }

  return {
    ok: true,
    stdout,
    stderr,
    code: 0,
    signal: null,
    spawnFailed: false,
    timedOut: false,
  };
}

/**
 * Reverse-look-up the registry to find the worktree key whose `worktree_path`
 * (resolved via realpath when possible) matches our worktreeRealpath. Matches
 * are realpath-aware: the registry file may store the symlinked path while we
 * receive the canonical one (or vice versa), so we resolve both before
 * comparing.
 *
 * Returns `null` for any miss (file not found, not JSON, no match) — never
 * throws.
 */
function lookupRegistryName(worktreeRealOrPath, registryPath) {
  if (!worktreeRealOrPath) return null;
  if (!existsSync(registryPath)) return null;

  let parsed;
  try {
    const raw = readFileSync(registryPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.worktrees ||
      typeof parsed.worktrees !== 'object') {
    return null;
  }

  // Pre-resolve our side once so we don't realpath() inside the loop.
  let mySide = worktreeRealOrPath;
  try {
    mySide = realpathSync(worktreeRealOrPath);
  } catch {
    // Keep mySide as-is — best-effort.
  }

  for (const [name, entry] of Object.entries(parsed.worktrees)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = typeof entry.worktree_path === 'string' ? entry.worktree_path : null;
    if (!candidate) continue;
    if (candidate === mySide || candidate === worktreeRealOrPath) {
      return name;
    }
    let candidateReal = candidate;
    try {
      candidateReal = realpathSync(candidate);
    } catch {
      // Skip — non-existent registry entry.
      continue;
    }
    if (candidateReal === mySide) return name;
  }
  return null;
}

function shortMessage(err) {
  if (!err) return 'unknown error';
  if (err.code) return `${err.code}${err.message ? `: ${truncate(err.message, 100)}` : ''}`;
  return truncate(String(err.message || err), 120);
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
