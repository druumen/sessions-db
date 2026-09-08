/** Root of codex's per-day rollout directories. Overridable for tests, same
 * contract as `DRUUMEN_CLAUDE_PROJECTS_ROOT` on the Claude side. */
export function codexSessionsRoot(): any;
/**
 * Read the first line of a file WITHOUT a size ceiling.
 *
 * See trap 1 in the module header: the fixed-window version of this function
 * reported "no session_meta" for every file on the machine. The 64 KiB chunk
 * is an IO granularity, not a limit — the loop keeps reading until it finds a
 * newline or the file ends.
 *
 * @param {string} path
 * @param {number} [maxBytes] hard stop so a pathological single-line file
 *   cannot be read into memory in full. Returns null when hit, which callers
 *   must treat as "unparseable", never as "no metadata".
 * @returns {string|null}
 */
export function readFirstLine(path: string, maxBytes?: number): string | null;
/** @param {string} text @returns {boolean} */
export function isInjectedPrompt(text: string): boolean;
/**
 * Parse one rollout file into the facts sessions-db stores.
 *
 * Streams line by line rather than `readFileSync`: the largest rollout on the
 * reference machine is tens of MB and this runs over the whole corpus.
 *
 * @param {string} path
 * @returns {{id: string, startedAt: string|null, lastActivityAt: string|null,
 *   cwd: string|null, originator: string|null, cliVersion: string|null,
 *   threadSource: string|null, firstPrompt: string|null, recordCount: number,
 *   path: string}|null}
 *   null when the file has no parseable `session_meta` — which means "we could
 *   not read it", NOT "it is not a session". Callers must not silently drop it.
 */
export function parseRollout(path: string): {
    id: string;
    startedAt: string | null;
    lastActivityAt: string | null;
    cwd: string | null;
    originator: string | null;
    cliVersion: string | null;
    threadSource: string | null;
    firstPrompt: string | null;
    recordCount: number;
    path: string;
} | null;
/**
 * Every rollout file under `root`, newest directory first.
 *
 * Walks the YYYY/MM/DD tree explicitly rather than a generic recursive glob so
 * an unrelated file dropped in `~/.codex` cannot be mistaken for a session.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function listRolloutFiles(root?: string): string[];
