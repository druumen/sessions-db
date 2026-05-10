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
