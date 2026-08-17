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
 * ⚠ DO NOT use `listTranscriptFiles(hash)[0]` as a "which transcript belongs
 * to this session?" fallback. A busy workspace directory holds hundreds of
 * unrelated transcripts and the newest one almost never belongs to the
 * session you are asking about — see `findTranscriptByCsid` for the exact,
 * safe lookup. This function is for enumeration (inventory / disk discovery),
 * not for identity.
 *
 * @param {string} workspaceHash dash-encoded hash, OR an absolute path that
 *   we will hash for you.
 * @returns {string[]}
 */
export function listTranscriptFiles(workspaceHash: string): string[];
/**
 * Locate the transcript for an EXACT claude_session_id by scanning every
 * workspace directory under `~/.claude/projects/` for `<csid>.jsonl`.
 *
 * Why this exists — the "newest jsonl in the workspace dir" fallback trap:
 * callers that fail to find `<hash>/<csid>.jsonl` used to degrade to
 * `listTranscriptFiles(hash)[0]` ("newest by mtime"). That heuristic was
 * harmless only while `workspaceHashFromCwd` was mis-encoding paths — the
 * directory was never found, so the fallback returned nothing. With the hash
 * fixed, the same fallback resolves a REAL directory holding 200+ unrelated
 * transcripts and hands back **another session's** file, which then gets
 * persisted into `transcript_files[]` and drives lineage matching. Attaching
 * a foreign transcript is strictly worse than attaching none.
 *
 * This function keeps the useful half of that fallback (tolerance for the
 * transcript living under a different workspace hash than the cwd we were
 * handed — happens when Claude Code is launched from a subdirectory or the
 * cwd is a symlink) while dropping the dangerous half (guessing by mtime).
 * The filename must equal the csid, so a hit is always the right file.
 *
 * Bounded cost: one readdir per workspace directory, no recursion into
 * `<session>/subagents/` (those are `agent-<hex>.jsonl`, never session ids).
 * Measured at ~35 dirs / ~300 files on a heavy machine.
 *
 * @param {string} claudeSessionId
 * @returns {string|null} absolute path, or null when no directory holds it
 */
export function findTranscriptByCsid(claudeSessionId: string): string | null;
/**
 * Build a Set of every claude_session_id that still has a transcript on disk,
 * by scanning `<projects-root>/*​/*.jsonl` once.
 *
 * Used by `prune` to answer "does this session exist on disk at all?" for
 * hundreds of records without paying a per-record directory walk. The
 * filename (minus `.jsonl`) IS the claude_session_id — that is Claude Code's
 * own naming contract and the same assumption `listTranscriptFiles` makes.
 *
 * Deliberately does NOT recurse: nested `subagents/agent-<hex>.jsonl` files
 * belong to sub-agents, not to top-level sessions, and including them would
 * pollute the index with ids that can never appear in `claude_session_ids[]`.
 *
 * Errors are swallowed per-directory: an unreadable workspace dir shrinks the
 * index rather than aborting the scan. Callers that treat "not in the index"
 * as "safe to delete" MUST pair this with a second, targeted existence check
 * (see `findTranscriptByCsid`) so a partial scan can never authorize a delete.
 *
 * @returns {{ csids: Set<string>, dirCount: number, fileCount: number,
 *   errors: string[] }}
 */
export function indexTranscriptCsids(): {
    csids: Set<string>;
    dirCount: number;
    fileCount: number;
    errors: string[];
};
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
