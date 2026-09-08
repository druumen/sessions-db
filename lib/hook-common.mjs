/**
 * Shared plumbing for sessions-db Claude Code hooks.
 *
 * Two hooks now write to the database — `SessionStart`
 * (`cli/sessions-db-session-start-main.mjs`) and `UserPromptSubmit`
 * (`cli/sessions-db-user-prompt-main.mjs`) — and they must agree EXACTLY on
 * the five decisions below, because a disagreement is not a cosmetic bug:
 *
 *   - **cwd-gate** — if the two hooks disagreed about which workspaces are
 *     opted in, one of them would be writing session data for a repo the user
 *     never consented to track.
 *   - **storage target** — if they disagreed, `SessionStart` would stage a
 *     pending record in one directory and `UserPromptSubmit` would look for it
 *     in another; promotion would never fire and every session would look
 *     brand new on its first prompt.
 *   - **stdin parsing / id validation / privacy opt-out** — same input
 *     contract, same failure modes, same env knob.
 *
 * These lived as private functions inside the SessionStart main until the
 * second hook arrived. They are lifted here (behaviour byte-for-byte
 * unchanged) rather than copied, so the two hooks cannot drift apart.
 *
 * Everything in this module obeys the hook safety contract: never throws,
 * never writes to stderr, no unbounded IO.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Read a single JSON object from stdin within `timeoutMs`. Returns null on
 * timeout, empty stdin, or invalid JSON. Never throws.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object|null>}
 */
export function readStdinJson({ timeoutMs = 100 } = {}) {
  return new Promise((resolve) => {
    // Detached / non-piped stdin (e.g. terminal): isTTY is true. Don't even
    // bother waiting.
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      if (chunks.length === 0) {
        finish(null);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (text.length === 0) {
          finish(null);
          return;
        }
        finish(JSON.parse(text));
      } catch {
        finish(null);
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/**
 * Decide whether a hook is allowed to record events for `cwd`.
 *
 * Two acceptance fast-paths, either of which is sufficient:
 *
 *   1. **Druumen Workspace sentinel** — a `CLAUDE.md` at `cwd` or any
 *      ancestor whose body contains the literal string "Druumen Workspace".
 *      Original 0.1.x gate; how the Druumen monorepo opts in.
 *
 *   2. **Pre-initialized sessions-db storage** — `.dru-code/sessions-db.json`
 *      or `tickets/_logs/sessions-db.json` already exists at `cwd` or any
 *      ancestor. The cockpit Setup Wizard creates this file when the user
 *      explicitly enables sessions tracking for a workspace; an external
 *      project that has never opted in will not have either marker.
 *
 * Either marker is treated as user consent for this workspace. The walk is
 * bounded to 12 ancestors so a runaway loop (e.g. weird FS mount) cannot
 * stall us; the loop terminates early as soon as ANY marker is found at the
 * current level.
 *
 * The function name is kept (`isDruumenWorkspace`) for git history clarity
 * even though the semantic has broadened to "authorized workspace".
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function isDruumenWorkspace(cwd) {
  return druumenWorkspaceRoot(cwd) !== null;
}

/**
 * WHICH workspace `cwd` belongs to — the same ascent `isDruumenWorkspace`
 * does, returning the directory instead of a boolean.
 *
 * Split out rather than duplicated: a caller standing in
 * `<workspace>/products/web` needs the workspace itself (to anchor storage and
 * a gate on it), and re-implementing the walk is how the two answers drift.
 * `isDruumenWorkspace` is now this function plus a null check, so there is
 * exactly one ascent in the package.
 *
 * @param {string} cwd
 * @returns {string|null} the workspace root, or null when `cwd` is not inside one
 */
export function druumenWorkspaceRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    // Fast-path 1: CLAUDE.md sentinel
    const claudeMd = join(dir, 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      try {
        // We only need the first ~8KB to find the sentinel; CLAUDE.md is
        // typically short, so reading the whole file is fine.
        const body = readFileSync(claudeMd, 'utf8');
        if (body.includes('Druumen Workspace')) return dir;
      } catch {
        // unreadable — keep walking up just in case there's a higher one.
      }
    }
    // Fast-path 2: pre-initialized sessions-db storage. Stat-only — we don't
    // read these files here, just check existence.
    if (hasInitializedStorage(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Does `dir` ITSELF already hold an initialized sessions-db (either storage
 * convention: cockpit-marketplace `.dru-code/` or druumen-monorepo
 * `tickets/_logs/`)? No ancestor walk — the question is specifically "is this
 * directory a storage root", not "is it inside a tracked workspace".
 *
 * Two callers, both of which need the narrow question:
 *   - `isDruumenWorkspace` walks ancestors itself and asks per level.
 *   - the `UserPromptSubmit` hook asks it about a cwd it is considering
 *     anchoring storage on when the git probe could not give it a worktree
 *     root. Anchoring on a directory that is NOT already a storage root would
 *     CREATE a second database inside the user's repo (observed: a
 *     `packages/deep/app/tickets/_logs/` appearing in `git status`), so "we
 *     already write here" is exactly the fact that has to be true.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function hasInitializedStorage(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  return (
    existsSync(join(dir, '.dru-code', 'sessions-db.json')) ||
    existsSync(join(dir, 'tickets', '_logs', 'sessions-db.json'))
  );
}

/**
 * Resolve which storage location a hook should write into.
 *
 * Three-tier strategy so cockpit-marketplace users (who have a `.dru-code/`
 * storage dir) and druumen-monorepo users (who have a `tickets/_logs/`
 * storage dir) BOTH have their hooks write into the exact location their
 * reader is watching:
 *
 *   (a) `DRUUMEN_SESSIONS_DB_ROOT` env var overrides everything. Cockpit's
 *       Setup Wizard writes this into the hook command line so the hook knows
 *       the precise storage dir the user opted into via Enable. Forwarded as
 *       `{ rootPath }` — storage treats it as the bare storage dir (no
 *       `tickets/_logs/` prefix added).
 *
 *   (b) Auto-detect `<workspaceRoot>/.dru-code/sessions-db.json`. If the user
 *       (or wizard) opted in via the new-convention layout we honor it
 *       without polluting their repo with a `tickets/_logs/` subdir.
 *
 *   (c) Fall back to the historic `{ root: workspaceRoot }` form which writes
 *       under `<workspaceRoot>/tickets/_logs/`.
 *
 * NEVER falls back to `process.cwd()` — the caller passes the workspace root
 * it committed to from the hook payload, which is the whole point.
 *
 * @param {{ workspaceRoot: string }} args
 * @returns {{ rootPath: string } | { root: string }}
 */
export function resolveStorageTarget({ workspaceRoot }) {
  const envRoot = process.env.DRUUMEN_SESSIONS_DB_ROOT;
  if (typeof envRoot === 'string' && envRoot.length > 0) {
    return { rootPath: envRoot };
  }
  if (existsSync(join(workspaceRoot, '.dru-code', 'sessions-db.json'))) {
    return { rootPath: join(workspaceRoot, '.dru-code') };
  }
  return { root: workspaceRoot };
}

/**
 * @param {unknown} v
 * @returns {string|null} `v` when it is a non-empty string, else null
 */
export function pickString(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Cheap UUID-shape validator. We don't want to lock ourselves to v4-only or
 * v7-only since Claude Code's session_id format may evolve, but we DO want to
 * reject obvious junk (empty / control chars / whitespace) that would corrupt
 * the events.jsonl line.
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function looksLikeUuid(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Privacy opt-out predicate for `DRUUMEN_SESSIONS_DB_STORE_PREVIEW`.
 *
 * Returns true ONLY for the literal opt-out values `'0'` and `'false'`
 * (case-insensitive, after trim). Everything else — unset, empty string,
 * `'1'`, `'true'`, `'yes'`, garbage — keeps the default-on behavior.
 *
 * Why this asymmetric shape? The default is preview-stored (backward compat
 * with 0.1.0-dev) and we want a typo in the env var to fail SAFE: an operator
 * who intends to opt out but mistypes (e.g. sets `=False` and trusts
 * case-insensitivity) gets opt-out, but a typo like `=fals` or `=disabled`
 * keeps the default. Treating only the two canonical strings as off-signals
 * makes the gate predictable; cockpit's Setup Wizard always writes one of the
 * two canonical values when the user unticks the box.
 *
 * @param {unknown} envValue
 * @returns {boolean}
 */
export function isPreviewDisabled(envValue) {
  if (typeof envValue !== 'string') return false;
  const v = envValue.trim().toLowerCase();
  return v === '0' || v === 'false';
}
