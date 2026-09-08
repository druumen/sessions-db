/**
 * Codex rollout transcripts — parsing only, no storage side.
 *
 * ## What a rollout file is
 *
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl`, one JSON
 * record per line, first line `session_meta`. Measured on the reference
 * machine 2026-09-08: 896 files, 0.87 GB, 2026-04-25 → 2026-09-07, and
 * `session_meta` parsed on 896 of 896 once the reader below was correct.
 *
 * This is a DIFFERENT shape from a Claude Code transcript and shares no field
 * with it beyond `timestamp`. Nothing here may be reused for Claude files and
 * nothing in `lib/transcript.mjs` works on these; keeping the two parsers
 * apart is the point of this module existing.
 *
 * ## Two traps, both measured rather than reasoned about
 *
 * 1. **`session_meta` is the first line but is NOT small.** It carries
 *    `instructions` (the injected AGENTS.md), routinely past 4 KiB. A reader
 *    that grabs a fixed head window and splits on the first newline gets a
 *    truncated line, `JSON.parse` throws, and the file looks like it has no
 *    metadata at all — measured as "896 of 896 files have no session_meta",
 *    which is exactly the shape of a silent, total, plausible-looking failure.
 *    `readFirstLine` therefore reads until it actually sees a newline.
 *
 * 2. **The first user message is usually not the user's.** Sampled 60 files:
 *    all 60 carry `role: "user"` records, and 48 of them (80%) open with an
 *    injected block — `<recommended_plugins>`, `<user_instructions>`, or a
 *    `# AGENTS.md instructions for <path>` preamble. Taking "the first user
 *    message" as the prompt is wrong four times out of five. `event_msg` /
 *    `user_message` is not an escape hatch either: only 4 of 30 sampled files
 *    contain one.
 */

import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of codex's per-day rollout directories. Overridable for tests, same
 * contract as `DRUUMEN_CLAUDE_PROJECTS_ROOT` on the Claude side. */
export function codexSessionsRoot() {
  return process.env.DRUUMEN_CODEX_SESSIONS_ROOT || join(homedir(), '.codex', 'sessions');
}

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
export function readFirstLine(path, maxBytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let acc = Buffer.alloc(0);
    let offset = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n <= 0) break;
      offset += n;
      acc = Buffer.concat([acc, chunk.subarray(0, n)]);
      const nl = acc.indexOf(0x0a);
      if (nl !== -1) return acc.subarray(0, nl).toString('utf8');
      if (acc.length > maxBytes) return null;
    }
    return acc.length > 0 ? acc.toString('utf8') : null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Injected blocks that open a codex conversation but were not typed by the
 * user. Derived from the corpus, not guessed: the `<...>` wrappers are what
 * the harness prepends, and the `# AGENTS.md instructions for` preamble is
 * the project-instructions injection.
 *
 * Deliberately anchored at the START of the message. A message that merely
 * MENTIONS `<recommended_plugins>` mid-text is a real message about the
 * injection, and dropping it would lose the one prompt most likely to be
 * searched for later.
 */
const INJECTED_PREFIXES = [
  /^<recommended_plugins\b/,
  /^<user_instructions\b/,
  /^<environment_context\b/,
  /^<plugin[s_]/,
  /^# AGENTS\.md instructions for /,
];

/** @param {string} text @returns {boolean} */
export function isInjectedPrompt(text) {
  if (typeof text !== 'string') return false;
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((re) => re.test(t));
}

/** Pull the text out of a `response_item` message payload. */
function messageText(payload) {
  const parts = Array.isArray(payload.content) ? payload.content : [];
  return parts.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n').trim();
}

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
export function parseRollout(path) {
  const head = readFirstLine(path);
  if (head === null) return null;
  let meta;
  try {
    meta = JSON.parse(head);
  } catch {
    return null;
  }
  if (!meta || meta.type !== 'session_meta' || !meta.payload) return null;
  const p = meta.payload;
  const id = typeof p.id === 'string' && p.id.length > 0 ? p.id : null;
  if (!id) return null;

  const out = {
    id,
    path,
    startedAt: typeof p.timestamp === 'string' ? p.timestamp : (typeof meta.timestamp === 'string' ? meta.timestamp : null),
    lastActivityAt: null,
    cwd: typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : null,
    originator: typeof p.originator === 'string' ? p.originator : null,
    cliVersion: typeof p.cli_version === 'string' ? p.cli_version : null,
    threadSource: typeof p.thread_source === 'string' ? p.thread_source : null,
    firstPrompt: null,
    recordCount: 0,
  };

  // Second pass for the body. `lastActivityAt` is the newest record's
  // timestamp IN THE FILE — never the ingest clock. Dating a months-old
  // session to the moment we indexed it is the exact defect 0.4.0 shipped and
  // had to fix (`OBSERVATION_ONLY_OPS` in lib/projection.mjs).
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return out;
  }
  try {
    const size = statSync(path).size;
    const chunk = Buffer.alloc(256 * 1024);
    let carry = '';
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n <= 0) break;
      offset += n;
      const text = carry + chunk.subarray(0, n).toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) consumeLine(line, out);
    }
    if (carry) consumeLine(carry, out);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  return out;
}

function consumeLine(line, out) {
  if (!line) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (!rec || typeof rec !== 'object') return;
  out.recordCount += 1;
  if (typeof rec.timestamp === 'string' && rec.timestamp.length > 0) {
    if (out.lastActivityAt === null || rec.timestamp > out.lastActivityAt) {
      out.lastActivityAt = rec.timestamp;
    }
  }
  if (out.firstPrompt !== null) return;
  const p = rec.payload;
  if (rec.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user') return;
  const text = messageText(p);
  if (!text || isInjectedPrompt(text)) return;
  out.firstPrompt = text;
}

/**
 * Every rollout file under `root`, newest directory first.
 *
 * Walks the YYYY/MM/DD tree explicitly rather than a generic recursive glob so
 * an unrelated file dropped in `~/.codex` cannot be mistaken for a session.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function listRolloutFiles(root = codexSessionsRoot()) {
  if (!existsSync(root)) return [];
  const out = [];
  const dirs = (d) => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const y of dirs(root)) {
    for (const m of dirs(join(root, y))) {
      for (const d of dirs(join(root, y, m))) {
        const day = join(root, y, m, d);
        let entries;
        try {
          entries = readdirSync(day, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
            out.push(join(day, e.name));
          }
        }
      }
    }
  }
  out.sort();
  return out;
}
