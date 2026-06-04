/**
 * Pure search helpers for `sessions-db search`. No IO — unit tested.
 *
 * Two tiers (the CLI wires both):
 *   - metadata: substring match across projection session fields (fast).
 *   - content : substring match across transcript message text (slow; the CLI
 *     does the file IO and calls `recordText` + `extractSnippet` here).
 *
 * Designed for AI-tool consumption: an agent runs `sessions-db search "<q>"
 * --json` over Bash to locate the past session that discussed something,
 * instead of a human digging through the cockpit list.
 */
/**
 * Labelled metadata strings a session exposes to search. Skips empty values.
 * @returns {Array<[string, string]>} [label, value] pairs
 */
export function sessionMetadataFields(session: any): Array<[string, string]>;
/**
 * Case-insensitive substring match across a session's metadata fields.
 * @returns {string[]} distinct field labels that matched ([] = no match)
 */
export function matchSessionMetadata(session: any, query: any): string[];
/**
 * Extract searchable text from one transcript JSONL record. Only user/assistant
 * messages carry conversation text; `content` is either a string or an array of
 * blocks ({ type, text }). Returns '' for anything else (tool_use, thinking,
 * queue-operation, attachment, ...).
 */
export function recordText(record: any): string;
/**
 * Return a whitespace-collapsed snippet around the first case-insensitive
 * occurrence of `query` in `text`, with `ctx` chars of context each side and
 * ellipses when truncated. Null if not found.
 */
export function extractSnippet(text: any, query: any, ctx?: number): string;
