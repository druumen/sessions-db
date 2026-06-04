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
export function sessionMetadataFields(session) {
  const fields = [];
  const push = (label, val) => {
    if (typeof val === 'string' && val.length > 0) fields.push([label, val]);
  };
  push('stable_id', session.stable_id);
  push('alias', session.alias);
  push('first_prompt', session.first_prompt_preview);
  push('branch', session.branch_current);
  push('branch', session.branch_at_start);
  push('cwd', session.cwd);
  push('worktree', session.worktree_realpath);
  push('worktree', session.worktree_path_observed);
  for (const t of Array.isArray(session.tasks) ? session.tasks : []) push('task', t);
  for (const p of Array.isArray(session.projects) ? session.projects : []) push('project', p);
  for (const id of Array.isArray(session.claude_session_ids) ? session.claude_session_ids : []) {
    push('claude_session_id', id);
  }
  return fields;
}

/**
 * Case-insensitive substring match across a session's metadata fields.
 * @returns {string[]} distinct field labels that matched ([] = no match)
 */
export function matchSessionMetadata(session, query) {
  if (!session || typeof session !== 'object' || typeof query !== 'string' || query.length === 0) {
    return [];
  }
  const q = query.toLowerCase();
  const hits = new Set();
  for (const [label, val] of sessionMetadataFields(session)) {
    if (val.toLowerCase().includes(q)) hits.add(label);
  }
  return [...hits];
}

/**
 * Extract searchable text from one transcript JSONL record. Only user/assistant
 * messages carry conversation text; `content` is either a string or an array of
 * blocks ({ type, text }). Returns '' for anything else (tool_use, thinking,
 * queue-operation, attachment, ...).
 */
export function recordText(record) {
  if (!record || (record.type !== 'user' && record.type !== 'assistant')) return '';
  const content = record.message && record.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter((t) => t.length > 0)
      .join(' ');
  }
  return '';
}

/**
 * Return a whitespace-collapsed snippet around the first case-insensitive
 * occurrence of `query` in `text`, with `ctx` chars of context each side and
 * ellipses when truncated. Null if not found.
 */
export function extractSnippet(text, query, ctx = 60) {
  if (typeof text !== 'string' || text.length === 0 || typeof query !== 'string' || query.length === 0) {
    return null;
  }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - ctx);
  const end = Math.min(text.length, idx + query.length + ctx);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}
