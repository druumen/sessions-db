/**
 * @typedef {{
 *   sessionId: string|null,
 *   firstUuid: string|null,
 *   lastUuid: string|null,
 *   firstParentUuid: string|null,
 *   recordCount: number,
 *   firstHumanPromptRaw: string|null,
 *   cwd: string|null,
 *   gitBranch: string|null,
 *   size: number,
 *   mtime: Date,
 *   status: 'ok' | 'corrupted' | 'too_large',
 * }} TranscriptMeta
 */
/**
 * Convert an absolute filesystem path to the dash-encoded workspace hash that
 * Claude Code uses for the `~/.claude/projects/<hash>/` directory name. The
 * encoding replaces every path separator and dot with a dash and keeps the
 * leading dash that Claude Code itself prepends.
 *
 * @param {string} cwd absolute path
 * @returns {string} e.g. `-Users-zm-leng-Documents-...-drummen-com-cn`
 */
export function workspaceHashFromCwd(cwd: string): string;
/**
 * List every `.jsonl` transcript in a workspace's Claude Code directory,
 * sorted by mtime descending (newest first). Returns absolute paths.
 *
 * @param {string} workspaceHash dash-encoded hash, OR an absolute path that
 *   we will hash for you.
 * @returns {string[]}
 */
export function listTranscriptFiles(workspaceHash: string): string[];
/**
 * Parse a single Claude Code transcript jsonl file and return its identity +
 * lineage metadata. Streams the file line-by-line; never loads the whole
 * thing into memory.
 *
 * @param {string} path absolute path to the jsonl file
 * @param {{ maxSizeMb?: number }} [opts]
 * @returns {Promise<TranscriptMeta>}
 */
export function parseTranscriptFile(path: string, opts?: {
    maxSizeMb?: number;
}): Promise<TranscriptMeta>;
export type TranscriptMeta = {
    sessionId: string | null;
    firstUuid: string | null;
    lastUuid: string | null;
    firstParentUuid: string | null;
    recordCount: number;
    firstHumanPromptRaw: string | null;
    cwd: string | null;
    gitBranch: string | null;
    size: number;
    mtime: Date;
    status: "ok" | "corrupted" | "too_large";
};
