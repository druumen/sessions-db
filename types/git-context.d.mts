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
export function gitContext(opts?: {
    cwd?: string;
    totalBudgetMs?: number;
    registryPath?: string;
}): Promise<GitContext>;
/**
 * @typedef {Object} FastGitContext
 * @property {string}      cwd          The cwd we probed.
 * @property {string|null} worktreePath `git rev-parse --show-toplevel`.
 * @property {string|null} branch       Current branch (null when detached).
 * @property {string|null} head         Full HEAD SHA.
 * @property {'ok'|'not_a_repo'|'error'} status
 * @property {string[]}    errors
 */
/**
 * One-spawn git probe for hooks that run on EVERY user turn.
 *
 * `gitContext()` above spawns six `git` processes (~44-110 ms wall on a warm
 * machine, measured). That is fine for SessionStart, which fires once per
 * session against a 2 s budget. It is NOT fine for `UserPromptSubmit`, which
 * fires on every single prompt and must stay inside a 200 ms p95 — six spawns
 * would eat more than half the budget for data that barely changes.
 *
 * This probe collapses the three fields a progress event actually needs into
 * a SINGLE `git rev-parse` invocation:
 *
 *     git rev-parse --show-toplevel HEAD --abbrev-ref HEAD
 *     → line 0: /abs/path/to/worktree
 *     → line 1: <40-hex HEAD sha>          (plain `HEAD`, before --abbrev-ref)
 *     → line 2: <branch> | "HEAD"          (after --abbrev-ref; "HEAD"=detached)
 *
 * Argument ORDER is load-bearing: `--abbrev-ref` applies to every rev that
 * follows it, so the bare `HEAD` must come first to yield the SHA. Swapping
 * them silently returns the branch name twice — there is a regression test
 * pinning the exact argv.
 *
 * Measured cost on the reference workspace: p50 5.9 ms / p95 6.3 ms — roughly
 * an order of magnitude cheaper than the six-probe context, and cheaper than
 * even the two-spawn (`branch --show-current` + `rev-parse HEAD`) form.
 *
 * Deliberately NOT collected here (all six-probe-only): worktreeRealpath,
 * gitCommonDir, isInWorktree, registryName. Those are stable-for-the-life-of-
 * a-session facts that SessionStart already captured; re-probing them on
 * every prompt buys nothing. Progress events carry only what actually drifts
 * mid-session: branch, HEAD.
 *
 * Same survival posture as `gitContext`: never throws, soft-fails to
 * `status:'error'`, and honours a single wall-clock deadline.
 *
 * @param {{ cwd?: string, totalBudgetMs?: number }} [opts]
 * @returns {Promise<FastGitContext>}
 */
export function gitContextFast(opts?: {
    cwd?: string;
    totalBudgetMs?: number;
}): Promise<FastGitContext>;
/**
 * Run a single `git <args>` command with a per-call budget derived from the
 * shared deadline. Uses non-blocking spawn + Promise.race so the hook's outer
 * setTimeout can actually fire (was: spawnSync blocked the event loop).
 *
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string,
 *   code: number|null, signal: NodeJS.Signals|null,
 *   spawnFailed: boolean, timedOut: boolean }>}
 */
export function runGit(args: any, { cwd, deadlineAt, encoding }: {
    cwd: any;
    deadlineAt: any;
    encoding?: string;
}, ctx: any): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnFailed: boolean;
    timedOut: boolean;
}>;
export type GitContext = {
    /**
     * The cwd we ran probes against (always set).
     */
    cwd: string;
    /**
     * Output of `git rev-parse --show-toplevel` (worktree root).
     */
    worktreePath: string | null;
    /**
     * realpath() of worktreePath, with symlinks resolved.
     */
    worktreeRealpath: string | null;
    /**
     * Output of `git rev-parse --git-common-dir` (resolved to absolute).
     */
    gitCommonDir: string | null;
    /**
     * True when worktree's `.git` is a file (linked worktree),
     * i.e. gitCommonDir's parent != worktreePath.
     */
    isInWorktree: boolean;
    /**
     * True when cwd is inside any git repo (linked worktree counts).
     */
    isInsideRepo: boolean;
    /**
     * `git branch --show-current` (empty string => detached HEAD => null).
     */
    branch: string | null;
    /**
     * `git rev-parse HEAD` (full SHA).
     */
    head: string | null;
    /**
     * Key in the dev-offload registry whose `worktree_path` matches us.
     */
    registryName: string | null;
    status: "ok" | "partial" | "not_a_repo" | "error";
    /**
     * One-liner error summaries, suitable for jsonl logging.
     */
    errors: string[];
};
export type FastGitContext = {
    /**
     * The cwd we probed.
     */
    cwd: string;
    /**
     * `git rev-parse --show-toplevel`.
     */
    worktreePath: string | null;
    /**
     * Current branch (null when detached).
     */
    branch: string | null;
    /**
     * Full HEAD SHA.
     */
    head: string | null;
    status: "ok" | "not_a_repo" | "error";
    errors: string[];
};
