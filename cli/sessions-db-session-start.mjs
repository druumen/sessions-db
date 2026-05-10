#!/usr/bin/env node
/**
 * sessions-db SessionStart hook — bootstrap shim.
 *
 * This file is INTENTIONALLY tiny. Its only job is to install three safety
 * nets BEFORE any project code is imported, then forward to the real main
 * module via dynamic `import()`. The split exists because ESM static imports
 * run before any top-level statements — meaning a failed import in the real
 * main module would leak a stack trace to stderr and exit the process with
 * code 1, completely bypassing the kill switch and exit-0 contract.
 *
 * Safety nets (in install order):
 *   1. process.on('uncaughtException' | 'unhandledRejection') → exit 0.
 *      Catches anything the dynamic import + main flow throws after this
 *      point, including project-side bugs we can't predict.
 *   2. DRUUMEN_SESSIONS_DB_DISABLED=1 kill switch. Exits before we even try
 *      to import the main module — useful for CI / docker / dev-offload
 *      sweeps that need to disable the hook without touching settings.json.
 *   3. setTimeout(2000, exit 0).unref(). The hard timeout. Now that no probe
 *      runs synchronously (git-context uses async spawn + global deadline,
 *      not spawnSync), this timer ACTUALLY fires when the event loop is
 *      otherwise busy. .unref() so a fast happy-path exits at natural
 *      completion without the timer keeping us alive.
 *
 * Only AFTER all three are armed do we `import()` the real main. Any import
 * error (corrupt main module, missing file, ESM resolution failure) is
 * swallowed by the uncaughtException handler — Claude Code never sees a
 * non-zero exit from us regardless.
 *
 * Wired by `.claude/settings.json` (in P5 — NOT in this phase) to fire on
 * every Claude Code SessionStart event.
 */

// (1) Silence error path. Install BEFORE any import so even a syntax error
// in the main module exits 0 silently. Both 'uncaughtException' and
// 'unhandledRejection' get the same treatment — promise rejections from
// inside the imported main are funneled here when not handled by main itself.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// (2) Kill switch. Env vars are available without imports — cheapest possible
// short-circuit. Lets ops teams disable the hook without modifying any code.
if (process.env.DRUUMEN_SESSIONS_DB_DISABLED === '1') {
  process.exit(0);
}

// (3) Hard timeout. Node built-in setTimeout, no import needed. .unref() so
// the timer never keeps the event loop alive past the hook's natural
// completion. With async git probes (no more spawnSync) this WILL fire when
// some probe is truly stuck — see hook safety contract item 2.
setTimeout(() => process.exit(0), 2000).unref();

// (4) NOW it is safe to import the real main. Any import-time failure
// (corrupted file, ESM resolution error, missing dependency) bubbles to the
// uncaughtException handler installed at step 1 → exits 0 silently.
import('./sessions-db-session-start-main.mjs').catch(() => process.exit(0));
