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

import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MAX_MB = 50;

/**
 * Root of Claude Code's per-workspace transcript directories. Resolved at call
 * time (not module load) and overridable via DRUUMEN_CLAUDE_PROJECTS_ROOT so
 * tests can point it at a temp dir; defaults to ~/.claude/projects.
 */
function claudeProjectsRoot() {
  return process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT || join(homedir(), '.claude', 'projects');
}

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
export const AI_TITLE_TAIL_MAX_BYTES = 256 * 1024;

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
  // Claude Code encodes a project dir by replacing EVERY non-alphanumeric
  // character with '-', per-character (consecutive separators are NOT
  // collapsed: "0 personal/留学/" → "0-personal----"). The previous regex
  // only mapped '/' and '.', so any workspace whose path contained '_',
  // space, '~', or non-ASCII produced a hash that never matched the real
  // ~/.claude/projects/<hash>/ directory — silently breaking transcript
  // location (hook tiers 2+3) and any disk-discovery fallback. Verified
  // against live dirs incl. '_' (zm_leng→zm-leng, com_cn→com-cn), space,
  // '~' (com~apple→com-apple), and CJK (留学→--).
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

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
export function listTranscriptFiles(workspaceHash) {
  const hash =
    workspaceHash.startsWith('/') ? workspaceHashFromCwd(workspaceHash) : workspaceHash;
  const dir = join(claudeProjectsRoot(), hash);
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
 * UUID shape guard for ids that get joined into a filesystem path.
 *
 * `claude_session_id` reaches these functions from hook stdin / library
 * callers, i.e. it is untrusted input, and it is interpolated into
 * `<root>/<dir>/<id>.jsonl`. Anything that is not a canonical UUID makes
 * `../../` representable — this is a path-traversal gate, not a politeness
 * check. Kept local (rather than imported) for the same reason `pending.mjs`
 * keeps its own copy: a path gate should not be able to break because some
 * other module refactored its exports.
 */
function isUuidLike(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

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
 * @param {string} claudeSessionId canonical UUID; anything else returns null
 * @returns {string|null} absolute path, or null when no directory holds it
 */
export function findTranscriptByCsid(claudeSessionId) {
  // Path gate, not input validation: `claudeSessionId` is joined into
  // `<root>/<dir>/<id>.jsonl`, so without this a caller passing
  // `../../secret` escapes the projects root and gets an existsSync hit on an
  // arbitrary file. The hook callers already run `looksLikeUuid` before they
  // get here, but this function is exported from `lib/index.mjs` and its
  // neighbour `pending.mjs` gates the identical input for the identical
  // reason — an exported path builder must not depend on its callers.
  if (!isUuidLike(claudeSessionId)) return null;
  const root = claudeProjectsRoot();
  const wanted = `${claudeSessionId}.jsonl`;
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = join(root, d.name, wanted);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

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
 * index rather than aborting the scan. A caller that treats "not in the index"
 * as "safe to delete" therefore MUST read `errors` and `fileCount` before
 * acting: an empty index is indistinguishable from "nothing on disk", and a
 * scan that failed outright still returns a well-formed empty result. See
 * `assessScanTrust` in `lib/prune.mjs` — the consumer that learned this the
 * hard way, and the reason `root` is reported back here (a wrong root, e.g.
 * `sudo` giving us `/var/root/.claude/projects`, is the failure mode most
 * likely to produce a silently empty scan).
 *
 * @returns {{ csids: Set<string>, dirCount: number, fileCount: number,
 *   errors: string[], root: string }}
 */
export function indexTranscriptCsids() {
  const root = claudeProjectsRoot();
  /** @type {Set<string>} */
  const csids = new Set();
  const errors = [];
  let dirCount = 0;
  let fileCount = 0;

  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    errors.push(`readdir(${root}): ${err && err.message ? err.message : String(err)}`);
    return { csids, dirCount, fileCount, errors, root };
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    dirCount += 1;
    let entries;
    try {
      entries = readdirSync(join(root, d.name), { withFileTypes: true });
    } catch (err) {
      errors.push(`readdir(${d.name}): ${err && err.message ? err.message : String(err)}`);
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      fileCount += 1;
      csids.add(f.name.slice(0, -'.jsonl'.length));
    }
  }
  return { csids, dirCount, fileCount, errors, root };
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
export function extractLatestAiTitle(path, opts = {}) {
  if (typeof path !== 'string' || path.length === 0) return null;
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st || st.size === 0) return null;

  const tailMax = Number.isFinite(opts.maxTailBytes) && opts.maxTailBytes > 0
    ? Math.floor(opts.maxTailBytes)
    : AI_TITLE_TAIL_MAX_BYTES;

  // Read the last min(size, tailMax) bytes of the file. We use openSync +
  // readSync + closeSync (sync, single syscall pair) to keep this fast and
  // synchronous — the hook's transcript probe sits on the critical path
  // and the file is local-disk.
  const readBytes = Math.min(st.size, tailMax);
  const startOffset = st.size - readBytes;
  const buf = Buffer.alloc(readBytes);
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    let total = 0;
    while (total < readBytes) {
      const got = readSync(fd, buf, total, readBytes - total, startOffset + total);
      if (got <= 0) break;
      total += got;
    }
    if (total === 0) return null;
    // Decode the (possibly partial-leading) tail to UTF-8. The first line
    // is almost always mid-record when startOffset > 0; we skip it
    // implicitly because JSON.parse on a truncated line throws and the
    // tolerant loop below ignores parse errors.
    const text = buf.slice(0, total).toString('utf8');
    const lines = text.split('\n');

    // Walk from the end. The very last element after split is the trailing
    // empty string when the file ends with '\n'; skip empty lines anyway.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.length === 0) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        rec &&
        typeof rec === 'object' &&
        rec.type === 'ai-title' &&
        typeof rec.aiTitle === 'string' &&
        rec.aiTitle.length > 0
      ) {
        return {
          aiTitle: rec.aiTitle,
          sessionId: typeof rec.sessionId === 'string' && rec.sessionId.length > 0
            ? rec.sessionId
            : null,
        };
      }
    }
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Extract the most-recent record of EACH Claude Code naming kind from a
 * transcript, in a single tail scan.
 *
 * Claude Code writes three kinds of naming record into the transcript jsonl,
 * and until now the hook only ever collected one of them:
 *
 *   { "type": "ai-title",     "aiTitle":     "...", "sessionId": "..." }
 *   { "type": "custom-title", "customTitle": "...", "sessionId": "..." }
 *   { "type": "agent-name",   "agentName":   "...", "sessionId": "..." }
 *
 * `custom-title` is USUALLY the one a human typed by hand — the strongest
 * statement of intent any of the naming surfaces produces — and nothing was
 * collecting it.
 *
 * "Usually" is doing real work there, and the record does not say which:
 * Claude Code writes its own `custom-title` when a session is resumed from
 * the picker (`Resume session <8 hex>`), in the same field, with nothing to
 * distinguish it from a typed one. `isMachineGeneratedCustomTitle` below
 * recognises that single known shape so the harvester can label it
 * `harvest` instead of `human`; any OTHER machine-written title this
 * surface grows in future will be indistinguishable and will be recorded as
 * human authorship. That is a known limit of the `source` axis on this
 * channel, not an oversight.
 *
 * ## Why one shared tail window is enough
 *
 * Same reasoning as `extractLatestAiTitle`, and measured rather than assumed.
 * Measured 2026-08-19 across the reference machine's transcript corpus (4381
 * files under `~/.claude/projects`; the corpus grows, the ratios are the
 * claim): `custom-title` appears in 6 files and its last occurrence sits
 * inside the 256 KiB tail in 6 of 6; `agent-name` in 8 files, 8 of 8. All
 * three kinds are re-emitted as the session goes on (median 13
 * `custom-title` records per file that has any, max 435), which is what keeps
 * a recent copy inside the window.
 *
 * Scanning once for all three costs exactly what scanning once for one did —
 * the expensive part is the read, not the compare.
 *
 * ## It also collects `pr-link`
 *
 * The name says titles, and the export keeps that name because it is public
 * surface (`lib/index.mjs`), but the same window carries one more fact worth
 * having: Claude Code writes
 *
 *   { "type": "pr-link", "prNumber": 722, "prUrl": "...",
 *     "prRepository": "druumen/cn/drummen", "timestamp": "..." }
 *
 * when a session opens a merge request. Collecting it here rather than in a
 * second scan is the same argument as above — the read is the expensive part,
 * and this one is already paid for. Unlike the names it is a LIST: a session
 * can open several MRs, and each is a separate fact about it.
 *
 * @param {string} path absolute path to a Claude Code transcript jsonl
 * @param {{ maxTailBytes?: number }} [opts]
 * @returns {{ aiTitle: string|null, customTitle: string|null,
 *   agentName: string|null, sessionId: string|null,
 *   prLinks: Array<{repository: string|null, number: number,
 *     url: string|null, observedAt: string|null}> }|null}
 *   `null` when the file is missing or empty. Individual name fields are null
 *   when the tail window holds no record of that kind; `prLinks` is `[]`,
 *   newest-first, never null.
 */
/**
 * Does this `custom-title` look like the one Claude Code writes for itself?
 *
 * Resuming a session from the picker stores `Resume session <first 8 hex of
 * the session id>` in the SAME field a person types into. On the reference
 * corpus that shape accounts for 1 of the 6 distinct custom titles; the other
 * 5 are real ("redesign BM overview", "定价分析", ...).
 *
 * Recognising it matters only for the `source` axis — precedence is per
 * channel, so a demoted title still outranks an `ai_title`. What it buys is
 * that "show me the names a HUMAN gave this session" does not answer with a
 * string the machine wrote. The predicate is deliberately exact rather than
 * fuzzy: a false positive silently downgrades a name somebody chose, which is
 * the more expensive mistake, and "Resume session deadbeef" is not something
 * a person types.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isMachineGeneratedCustomTitle(value) {
  return typeof value === 'string' && /^Resume session [0-9a-f]{8}$/.test(value);
}

export function extractLatestTitles(path, opts = {}) {
  if (typeof path !== 'string' || path.length === 0) return null;
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st || st.size === 0) return null;

  const tailMax = Number.isFinite(opts.maxTailBytes) && opts.maxTailBytes > 0
    ? Math.floor(opts.maxTailBytes)
    : AI_TITLE_TAIL_MAX_BYTES;

  const readBytes = Math.min(st.size, tailMax);
  const startOffset = st.size - readBytes;
  const buf = Buffer.alloc(readBytes);
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    let total = 0;
    while (total < readBytes) {
      const got = readSync(fd, buf, total, readBytes - total, startOffset + total);
      if (got <= 0) break;
      total += got;
    }
    if (total === 0) return null;

    const lines = buf.slice(0, total).toString('utf8').split('\n');
    const out = { aiTitle: null, customTitle: null, agentName: null, sessionId: null, prLinks: [] };
    // Field name per record type. Kept as data so adding a fourth naming
    // record is a one-line change rather than a fourth branch.
    const FIELDS = {
      'ai-title': ['aiTitle', 'aiTitle'],
      'custom-title': ['customTitle', 'customTitle'],
      'agent-name': ['agentName', 'agentName'],
    };

    // Cheap pre-filter. Every kind this scan collects carries its own literal
    // in the line, so a substring test rejects the ~99% of lines that are
    // conversation turns without paying for JSON.parse. It is deliberately
    // matched against the KIND names and not `"type":"…"`: Claude Code writes
    // compact JSON today, and a scan that silently stops working if it ever
    // emits a space after the colon is a scan that fails without saying so.
    // A false positive (a message that merely mentions "pr-link") costs one
    // parse and is then rejected by the type check below.
    const MAYBE = (line) => line.indexOf('-title') !== -1 ||
      line.indexOf('agent-name') !== -1 ||
      line.indexOf('pr-link') !== -1;

    // Dedupe key → index in out.prLinks, so a link re-emitted every few KB is
    // one entry.
    const linkIndex = new Map();

    // Walk backwards; the first record of a kind we meet is that kind's most
    // recent.
    //
    // There is no early exit any more. It used to stop as soon as all three
    // names were filled, which cannot survive collecting pr-links: a session
    // opens more than one MR (this machine has sessions carrying #672 and
    // #722), so "we have one" is never proof there is not another older one
    // further up the window. Measured 2026-09-07 on the 41.2 MB reference
    // transcript (12 runs each, two rounds): whole window + pre-filter p50
    // 0.78-0.81 ms against the old early-exit walk's 0.84-0.96 ms — dropping
    // the exit cost nothing because the expensive part was never the compare,
    // it was the parses the pre-filter now avoids.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.length === 0 || !MAYBE(line)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // Expected for the leading line of the window (almost always cut
        // mid-record) and tolerated everywhere else.
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;

      if (rec.type === 'pr-link') {
        // A link we cannot address is not a link: the number is what makes it
        // referenceable, and `prRepository` is what keeps `#722` unambiguous
        // once a session touches more than one repo.
        const number = Number.isInteger(rec.prNumber) && rec.prNumber > 0 ? rec.prNumber : null;
        if (number === null) continue;
        const repository = typeof rec.prRepository === 'string' && rec.prRepository.length > 0
          ? rec.prRepository
          : null;
        const key = `${repository ?? ''}#${number}`;
        const at = typeof rec.timestamp === 'string' && rec.timestamp.length > 0 ? rec.timestamp : null;
        const existing = linkIndex.get(key);
        if (existing === undefined) {
          linkIndex.set(key, out.prLinks.length);
          out.prLinks.push({
            repository,
            number,
            url: typeof rec.prUrl === 'string' && rec.prUrl.length > 0 ? rec.prUrl : null,
            observedAt: at,
          });
        } else if (at !== null) {
          // Walking backwards means every later meeting of the same key is an
          // EARLIER emission, so this keeps the first time the link was seen
          // rather than the last — "when did this session open that MR".
          out.prLinks[existing].observedAt = at;
        }
        if (out.sessionId === null && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
          out.sessionId = rec.sessionId;
        }
        continue;
      }

      const spec = FIELDS[rec.type];
      if (!spec) continue;
      const [recField, outField] = spec;
      if (out[outField] !== null) continue; // already have a newer one
      const value = rec[recField];
      if (typeof value !== 'string' || value.length === 0) continue;
      out[outField] = value;
      if (out.sessionId === null && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
        out.sessionId = rec.sessionId;
      }
    }
    return out;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
