/**
 * Output formatting helpers for sessions-db CLI subcommands.
 *
 * Supports three output styles:
 *  - `formatSessionTable` — fixed-column ASCII table for `find` (default).
 *  - `formatTree` — hub-spoke ASCII tree rooted at a stable_id (depth-capped
 *    to defend against circular parent_session_id chains).
 *  - `formatJSON` — pretty-printed JSON.stringify with stable key order.
 *
 * No external deps — color is pure ANSI escape codes, gated by a TTY check
 * the CLI entry can override with NO_COLOR=1 / --no-color.
 *
 * The depth cap matters: P3 identity surfaces parent_candidates as hub-spoke
 * hints, but the actual `parent_session_id` is set by `link-parent`. A user
 * could (accidentally or maliciously) create A→B→A. We cap recursion at
 * MAX_TREE_DEPTH and surface a `(circular reference)` marker so the operator
 * can fix it via `link-parent --remove`.
 */

const MAX_TREE_DEPTH = 32;

// ANSI escape codes (zero-dep). Disabled when NO_COLOR is set or stdout is
// not a TTY (caller's responsibility — pass useColor=false to bypass).
const ANSI = Object.freeze({
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
});

function paint(text, color, useColor) {
  if (!useColor || !color) return text;
  return color + text + ANSI.reset;
}

/**
 * Truncate a stable_id to the first 16 chars for display
 * (sess_<8>-<4>... is enough for visual disambiguation).
 *
 * Exported so tests can verify identical truncation rules across handlers.
 */
export function truncateStableId(id) {
  if (typeof id !== 'string') return '<invalid>';
  if (id.length <= 22) return id;
  return id.slice(0, 22);
}

/**
 * Human-friendly relative time ("3 hours ago", "2 days ago", "just now").
 *
 * Exported because both find (table cell) and tree (state suffix) want the
 * same relative-time vocabulary so ops staff don't see "3h" in one place and
 * "3 hours ago" in another.
 *
 * @param {string|null|undefined} iso - ISO 8601 timestamp
 * @param {number} [now=Date.now()] - injectable for deterministic tests
 */
export function relTime(iso, now = Date.now()) {
  if (!iso || typeof iso !== 'string') return '-';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  const deltaMs = now - t;
  if (deltaMs < 0) return 'in the future';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

/**
 * Format a list of session records as a fixed-column ASCII table.
 *
 * @param {Array<object>} sessions
 * @param {{ useColor?: boolean, now?: number }} [opts]
 * @returns {string}
 */
export function formatSessionTable(sessions, opts = {}) {
  const useColor = opts.useColor === true;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return '(no sessions matched)\n';
  }

  const rows = sessions.map((s) => ({
    stable: truncateStableId(s.stable_id || ''),
    alias: s.alias || '-',
    state: s.activity_state || '-',
    outcome: s.outcome || '-',
    last: relTime(s.last_progress_at, now),
    branch: truncBranch(s.branch_current || s.branch_at_start),
    cwd: truncCwd(s.cwd || s.worktree_path_observed),
  }));

  const headers = {
    stable: 'stable_id',
    alias: 'alias',
    state: 'state',
    outcome: 'outcome',
    last: 'last_progress',
    branch: 'branch',
    cwd: 'cwd',
  };

  const widths = {
    stable: Math.max(headers.stable.length, ...rows.map((r) => r.stable.length)),
    alias: Math.max(headers.alias.length, ...rows.map((r) => r.alias.length)),
    state: Math.max(headers.state.length, ...rows.map((r) => r.state.length)),
    outcome: Math.max(headers.outcome.length, ...rows.map((r) => r.outcome.length)),
    last: Math.max(headers.last.length, ...rows.map((r) => r.last.length)),
    branch: Math.max(headers.branch.length, ...rows.map((r) => r.branch.length)),
    cwd: Math.max(headers.cwd.length, ...rows.map((r) => r.cwd.length)),
  };

  const fmt = (r, isHeader = false) => {
    const cells = [
      r.stable.padEnd(widths.stable),
      r.alias.padEnd(widths.alias),
      paintState(r.state, useColor && !isHeader, widths.state),
      paintOutcome(r.outcome, useColor && !isHeader, widths.outcome),
      r.last.padEnd(widths.last),
      r.branch.padEnd(widths.branch),
      r.cwd.padEnd(widths.cwd),
    ];
    return cells.join('  ').trimEnd();
  };

  const lines = [];
  lines.push(paint(fmt(headers, true), useColor ? ANSI.bold : null, useColor));
  for (const r of rows) lines.push(fmt(r));
  return lines.join('\n') + '\n';
}

function paintState(state, useColor, width) {
  const padded = state.padEnd(width);
  if (!useColor) return padded;
  if (state === 'active') return paint(padded, ANSI.green, true);
  if (state === 'idle') return paint(padded, ANSI.yellow, true);
  if (state === 'archived') return paint(padded, ANSI.gray, true);
  return padded;
}

function paintOutcome(outcome, useColor, width) {
  const padded = outcome.padEnd(width);
  if (!useColor) return padded;
  if (outcome === 'open') return paint(padded, ANSI.cyan, true);
  if (outcome === 'done' || outcome === 'merged') return paint(padded, ANSI.green, true);
  if (outcome === 'blocked') return paint(padded, ANSI.red, true);
  return padded;
}

function truncBranch(branch) {
  if (!branch) return '-';
  if (branch.length <= 32) return branch;
  return branch.slice(0, 29) + '...';
}

function truncCwd(cwd) {
  if (!cwd) return '-';
  if (cwd.length <= 40) return cwd;
  // Keep the tail (most informative — the trailing dir reveals which
  // worktree / project this is) and prefix with `…`.
  return '...' + cwd.slice(-37);
}

/**
 * Format a hub-spoke tree rooted at `rootStableId`.
 *
 * @param {string} rootStableId
 * @param {object} projection
 * @param {{ useColor?: boolean, now?: number }} [opts]
 * @returns {string} ASCII tree text or an error sentinel string when root
 *   does not exist (caller decides exit code).
 */
export function formatTree(rootStableId, projection, opts = {}) {
  const useColor = opts.useColor === true;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  const sessions = projection && projection.sessions ? projection.sessions : {};
  if (!sessions[rootStableId]) {
    return `error: stable_id not found: ${rootStableId}\n`;
  }

  // Build child index: parent_session_id → [child stable_ids]
  const children = new Map();
  for (const [sid, s] of Object.entries(sessions)) {
    const parent = s && typeof s.parent_session_id === 'string' ? s.parent_session_id : null;
    if (parent && parent !== sid) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(sid);
    }
  }
  // Sort children by created_at ASC for stable, deterministic output.
  for (const arr of children.values()) {
    arr.sort((a, b) => {
      const ca = sessions[a] && sessions[a].created_at;
      const cb = sessions[b] && sessions[b].created_at;
      if (!ca && !cb) return 0;
      if (!ca) return 1;
      if (!cb) return -1;
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });
  }

  const lines = [];
  const visited = new Set();

  function nodeLabel(sid) {
    const s = sessions[sid];
    const idShort = truncateStableId(sid);
    const alias = s && s.alias ? ` (${s.alias})` : '';
    const stateLabel = s
      ? `[${s.activity_state || '?'}/${s.outcome || '?'}]`
      : '[?/?]';
    const last = s ? ` ${relTime(s.last_progress_at, now)}` : '';
    return `${paint(idShort, useColor ? ANSI.bold : null, useColor)}${alias} ${paint(stateLabel, useColor ? ANSI.dim : null, useColor)}${last}`;
  }

  function emit(sid, prefix, isLast, depth) {
    const connector = depth === 0 ? '' : (isLast ? '└── ' : '├── ');
    lines.push(prefix + connector + nodeLabel(sid));

    if (depth >= MAX_TREE_DEPTH) {
      lines.push(prefix + (isLast ? '    ' : '│   ') + paint('(max depth reached)', useColor ? ANSI.yellow : null, useColor));
      return;
    }

    if (visited.has(sid)) {
      lines.push(prefix + (isLast ? '    ' : '│   ') + paint('(circular reference)', useColor ? ANSI.red : null, useColor));
      return;
    }
    visited.add(sid);

    const kids = children.get(sid) || [];
    const childPrefix = prefix + (depth === 0 ? '' : (isLast ? '    ' : '│   '));
    for (let i = 0; i < kids.length; i++) {
      emit(kids[i], childPrefix, i === kids.length - 1, depth + 1);
    }
  }

  emit(rootStableId, '', true, 0);
  return lines.join('\n') + '\n';
}

/**
 * Format any value as JSON with stable 2-space indentation.
 * @param {any} data
 * @returns {string}
 */
export function formatJSON(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * Decide whether to enable ANSI color: TTY + NO_COLOR not set + --no-color
 * not passed. Exposed so the CLI entry / handlers can call it once at the
 * start and pass the boolean down to formatters.
 */
export function shouldUseColor(streamIsTTY, env = process.env, noColorFlag = false) {
  if (noColorFlag) return false;
  if (env && env.NO_COLOR && env.NO_COLOR.length > 0) return false;
  return streamIsTTY === true;
}
