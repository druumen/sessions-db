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
/**
 * Extract the most-recent `ai-title` event from a Claude Code transcript by
 * tail-scanning the last `AI_TITLE_TAIL_MAX_BYTES` of the file.
 *
 * Claude Code persists its AI-generated session title as JSONL records of
 * the shape `{ "type": "ai-title", "sessionId": "<uuid>", "aiTitle": "<text>" }`.
 * These are re-emitted many times as the title is refined (we have observed
 * 87 occurrences in a single 27-hour session) — the last one is the title
 * the `/resume` UI displays.
 *
 * Implementation notes:
 *  - **Tail-only scan**: we read at most the last `AI_TITLE_TAIL_MAX_BYTES`
 *    of the file (default 256 KiB). Some transcripts are 3+ MB; loading
 *    the whole file would defeat the hook's < 2 second budget. Because
 *    Claude Code re-emits ai-title records frequently, a recent one is
 *    almost always inside the tail window.
 *  - **No full-file fallback**: when the tail window contains no ai-title
 *    we return `null` instead of escalating to a full scan. The next
 *    session_start event will pick it up cheaply if/when Claude Code emits
 *    a fresh ai-title record into the tail.
 *  - **Tolerant**: malformed lines (including the truncated leading line
 *    that the tail window almost always starts mid-record) are skipped.
 *    Records without an `aiTitle` string field are skipped.
 *  - **Latest by file position**: we iterate the lines in reverse and
 *    return the first valid `ai-title` we hit, which is the most-recent
 *    by file position.
 *
 * @param {string} path absolute path to a Claude Code transcript jsonl
 * @param {{ maxTailBytes?: number }} [opts]
 * @returns {{ aiTitle: string, sessionId: string|null }|null}
 *   `null` when the file is missing, empty, or the tail window contains
 *   no parseable `ai-title` record.
 */
export function extractLatestAiTitle(path: string, opts?: {
    maxTailBytes?: number;
}): {
    aiTitle: string;
    sessionId: string | null;
} | null;
/**
 * Maximum bytes scanned from the tail of a transcript when looking for the
 * latest `ai-title` record. Tuned at 256 KiB — large enough that any recent
 * ai-title (Claude Code emits these several KB apart in active sessions)
 * sits in the window, small enough to keep the hook fast even on a
 * many-megabyte transcript. If no ai-title is found in this window we
 * return null rather than degrading to a full-file scan; the rolling tail
 * window is sufficient because Claude Code re-emits ai-title records many
 * times per session as the title is refined.
 */
export const AI_TITLE_TAIL_MAX_BYTES: number;
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
