/**
 * Claude Code transcript jsonl reader.
 *
 * Layout assumption: every transcript is `~/.claude/projects/<workspace-hash>/
 * <session_uuid>.jsonl`, one JSON record per line. Records mix several types
 * (`user`, `assistant`, `system`, `attachment`, `queue-operation`,
 * `file-history-snapshot`, `ai-title`, `last-prompt`); only some carry the
 * `uuid` / `parentUuid` lineage fields. We therefore consider only records
 * with a `uuid` for firstUuid/lastUuid/firstParentUuid extraction.
 *
 * The "first human prompt" is the first `type === 'user'` record matching
 * any of these (fallback chain, first hit wins):
 *   1. `userType === 'external'` — empirical truth, what current Claude Code
 *      emits for human/IDE-originated messages.
 *   2. `userType === 'human'` — what the design ticket assumed; included for
 *      forward compat if Claude Code ever switches to the spec value.
 *   3. `message.role === 'user'` — semantic fallback when neither userType
 *      label is present (older harness builds, third-party tooling).
 * If none match we leave firstHumanPromptRaw=null rather than mis-attributing
 * a tool-result echo as the human's prompt.
 *
 * The reader is streaming (line-by-line) so it stays bounded on memory
 * regardless of file size. We bail out before opening if the file exceeds
 * `maxSizeMb` (default 50) and report `status: 'too_large'`.
 */

import { createReadStream, statSync, readdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MAX_MB = 50;
const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

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
export function workspaceHashFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new TypeError(`workspaceHashFromCwd: expected absolute path, got ${cwd}`);
  }
  return cwd.replace(/[/.]/g, '-');
}

/**
 * List every `.jsonl` transcript in a workspace's Claude Code directory,
 * sorted by mtime descending (newest first). Returns absolute paths.
 *
 * @param {string} workspaceHash dash-encoded hash, OR an absolute path that
 *   we will hash for you.
 * @returns {string[]}
 */
export function listTranscriptFiles(workspaceHash) {
  const hash =
    workspaceHash.startsWith('/') ? workspaceHashFromCwd(workspaceHash) : workspaceHash;
  const dir = join(CLAUDE_PROJECTS_ROOT, hash);
  if (!existsSync(dir)) return [];

  /** @type {{ path: string, mtime: number }[]} */
  const rows = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const full = join(dir, entry.name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    rows.push({ path: full, mtime: st.mtimeMs });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.map((r) => r.path);
}

/**
 * Pick out the human-readable text from a `message.content` field, which is
 * either a plain string or an array of `{type, text}` objects. Non-text items
 * (tool results, images, etc.) are dropped.
 *
 * @param {unknown} content
 * @returns {string|null}
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
  }
  return null;
}

/**
 * Parse a single Claude Code transcript jsonl file and return its identity +
 * lineage metadata. Streams the file line-by-line; never loads the whole
 * thing into memory.
 *
 * @param {string} path absolute path to the jsonl file
 * @param {{ maxSizeMb?: number }} [opts]
 * @returns {Promise<TranscriptMeta>}
 */
export async function parseTranscriptFile(path, opts = {}) {
  const maxSizeMb = Number.isFinite(opts.maxSizeMb) && opts.maxSizeMb > 0
    ? opts.maxSizeMb
    : DEFAULT_MAX_MB;

  const st = statSync(path);
  /** @type {TranscriptMeta} */
  const meta = {
    sessionId: null,
    firstUuid: null,
    lastUuid: null,
    firstParentUuid: null,
    recordCount: 0,
    firstHumanPromptRaw: null,
    cwd: null,
    gitBranch: null,
    size: st.size,
    mtime: st.mtime,
    status: 'ok',
  };

  if (st.size > maxSizeMb * 1024 * 1024) {
    meta.status = 'too_large';
    return meta;
  }

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sawAnyValidRecord = false;
  let parseErrors = 0;
  // Track first parent-bearing record separately so we can decide whether the
  // file represents a fresh session (firstParentUuid === null) or a resume
  // (parentUuid points into another file).
  let firstUuidBearingRecord = null;

  for await (const line of rl) {
    if (line.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!rec || typeof rec !== 'object') {
      parseErrors += 1;
      continue;
    }
    sawAnyValidRecord = true;
    meta.recordCount += 1;

    // sessionId is consistent across the file; latch the first non-empty.
    if (meta.sessionId === null && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
      meta.sessionId = rec.sessionId;
    }

    // cwd / gitBranch — first non-empty wins.
    if (meta.cwd === null && typeof rec.cwd === 'string' && rec.cwd.length > 0) {
      meta.cwd = rec.cwd;
    }
    if (meta.gitBranch === null && typeof rec.gitBranch === 'string' && rec.gitBranch.length > 0) {
      meta.gitBranch = rec.gitBranch;
    }

    // Lineage tracking: only records with a `uuid` participate.
    if (typeof rec.uuid === 'string' && rec.uuid.length > 0) {
      if (firstUuidBearingRecord === null) {
        firstUuidBearingRecord = rec;
        meta.firstUuid = rec.uuid;
        meta.firstParentUuid = typeof rec.parentUuid === 'string' ? rec.parentUuid : null;
      }
      meta.lastUuid = rec.uuid;
    }

    // First human prompt: type='user' AND any of the userType fallbacks
    // (external = empirical, human = ticket spec, message.role = semantic).
    if (
      meta.firstHumanPromptRaw === null &&
      rec.type === 'user' &&
      rec.message &&
      (
        rec.userType === 'external' ||
        rec.userType === 'human' ||
        rec.message.role === 'user'
      )
    ) {
      const text = extractText(rec.message.content);
      if (text !== null) meta.firstHumanPromptRaw = text;
    }
  }

  if (!sawAnyValidRecord) {
    meta.status = parseErrors > 0 ? 'corrupted' : 'ok';
  } else if (parseErrors > 0 && meta.recordCount === 0) {
    // We skipped some lines but never recovered a usable record.
    meta.status = 'corrupted';
  }

  return meta;
}
