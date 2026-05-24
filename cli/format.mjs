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

  const rows = sessions.map((s) => {
    // "label" column display priority (added in 0.1.6):
    //   alias  → user-set, highest priority
    //   ai_title → harvested from Claude Code transcript; tagged [ai]
    //   first_prompt_preview → first user message (truncated); tagged [preview]
    //   '-' → none available
    const label = pickLabel(s);
    return {
      stable: truncateStableId(s.stable_id || ''),
      label: label.text,
      labelSource: label.source,
      state: s.activity_state || '-',
      outcome: s.outcome || '-',
      last: relTime(s.last_progress_at, now),
      branch: truncBranch(s.branch_current || s.branch_at_start),
      cwd: truncCwd(s.cwd || s.worktree_path_observed),
    };
  });

  const headers = {
    stable: 'stable_id',
    label: 'label',
    state: 'state',
    outcome: 'outcome',
    last: 'last_progress',
    branch: 'branch',
    cwd: 'cwd',
  };

  // For column-width math, account for the inline source tag (`[ai]` /
  // `[preview]`) we render alongside the label so adjacent columns don't
  // overlap when colors strip out.
  const labelRendered = rows.map((r) => renderLabelCell(r, /* useColor */ false));

  const widths = {
    stable: Math.max(headers.stable.length, ...rows.map((r) => r.stable.length)),
    label: Math.max(headers.label.length, ...labelRendered.map((s) => s.length)),
    state: Math.max(headers.state.length, ...rows.map((r) => r.state.length)),
    outcome: Math.max(headers.outcome.length, ...rows.map((r) => r.outcome.length)),
    last: Math.max(headers.last.length, ...rows.map((r) => r.last.length)),
    branch: Math.max(headers.branch.length, ...rows.map((r) => r.branch.length)),
    cwd: Math.max(headers.cwd.length, ...rows.map((r) => r.cwd.length)),
  };

  const fmt = (r, isHeader = false) => {
    const labelCell = isHeader
      ? r.label.padEnd(widths.label)
      : padLabelCell(r, widths.label, useColor);
    const cells = [
      r.stable.padEnd(widths.stable),
      labelCell,
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

/**
 * Maximum displayed length of the "label" column body (excluding the
 * `[ai]` / `[preview]` source tag). Aliases and ai_titles are usually
 * short, but a raw first_prompt_preview can be ~200 chars after
 * sanitization — we truncate to keep the table readable.
 */
const LABEL_MAX_LEN = 48;
const PREVIEW_MAX_LEN = 60;

/**
 * Pick which field to display in the `find` table's "label" column, with
 * source-aware truncation. The display priority is alias > ai_title >
 * first_prompt_preview > "-".
 *
 * Returns `{ text, source }` where source is one of:
 *   - 'alias'   — user-set label (no inline tag, the cleanest case)
 *   - 'ai_title' — AI-harvested title (rendered with `[ai]` suffix)
 *   - 'preview' — sanitized first prompt excerpt (rendered with `[preview]`
 *     suffix) — truncated to 60 chars to fit the table
 *   - 'none'    — nothing available; text is '-'
 *
 * Exported so tests + future tooling (e.g. tree-view) can apply the same
 * "what should we call this session" priority without re-implementing it.
 */
export function pickLabel(session) {
  if (!session || typeof session !== 'object') return { text: '-', source: 'none' };
  if (typeof session.alias === 'string' && session.alias.length > 0) {
    return { text: truncateLabel(session.alias, LABEL_MAX_LEN), source: 'alias' };
  }
  if (typeof session.ai_title === 'string' && session.ai_title.length > 0) {
    return { text: truncateLabel(session.ai_title, LABEL_MAX_LEN), source: 'ai_title' };
  }
  if (typeof session.first_prompt_preview === 'string' && session.first_prompt_preview.length > 0) {
    return {
      text: truncateLabel(session.first_prompt_preview, PREVIEW_MAX_LEN),
      source: 'preview',
    };
  }
  return { text: '-', source: 'none' };
}

function truncateLabel(text, max) {
  // Collapse newlines so the label stays a single visual cell.
  const flat = text.replace(/[\r\n]+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 3) + '...';
}

/**
 * Render a row's label cell as plain text (no color) for column-width math.
 * Includes the inline `[ai]` / `[preview]` source tag so the width
 * calculation is accurate.
 */
function renderLabelCell(row, useColor) {
  const tag = row.labelSource === 'ai_title'
    ? ' [ai]'
    : row.labelSource === 'preview'
      ? ' [preview]'
      : '';
  if (!useColor || tag.length === 0) return row.label + tag;
  return row.label + paint(tag, ANSI.dim, true);
}

/**
 * Pad a label cell to `width` columns, applying the source tag and
 * (optionally) ANSI color. Color codes are not counted toward padding —
 * we compute the plain-text width first, then inject color around the
 * tag so columns align visually whether color is on or off.
 */
function padLabelCell(row, width, useColor) {
  const plain = renderLabelCell(row, /* useColor */ false);
  const pad = ' '.repeat(Math.max(0, width - plain.length));
  if (!useColor) return plain + pad;
  return renderLabelCell(row, /* useColor */ true) + pad;
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
