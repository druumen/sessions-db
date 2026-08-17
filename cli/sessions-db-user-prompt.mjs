#!/usr/bin/env node
/**
 * sessions-db UserPromptSubmit hook — bootstrap shim.
 *
 * Same three-safety-net structure as the SessionStart bootstrap, and for the
 * same reason: ESM static imports run before any top-level statement, so a
 * failed import in the real main module would leak a stack trace to stderr
 * and exit non-zero, bypassing both the kill switch and the exit-0 contract.
 * Only after all three nets are armed do we dynamically `import()` main.
 *
 * Safety nets (in install order):
 *   1. process.on('uncaughtException' | 'unhandledRejection') → exit 0.
 *   2. DRUUMEN_SESSIONS_DB_DISABLED=1 kill switch, before any import.
 *   3. setTimeout(1000, exit 0).unref() — the hard timeout.
 *
 * ## Why 1000 ms here and 2000 ms in SessionStart
 *
 * This hook runs on EVERY user turn, in front of the user, on the latency
 * path between pressing Enter and Claude starting to think. SessionStart runs
 * once per session while the user is already waiting for a process to boot.
 * A budget that is generous for the once-per-session case is a tax when it is
 * paid on every prompt, so this hook is held to a 200 ms p95 target and gets
 * a hard ceiling half the size.
 *
 * The work is sized to fit: one `git rev-parse` (single spawn, ~6 ms — see
 * `gitContextFast`) instead of the six-probe context, no transcript parse at
 * all (the prompt text arrives in the hook payload), and one projection
 * read-modify-write (~33 ms p95 on a 623-session / 1.35 MB database). The
 * timer is the backstop for a wedged filesystem or a contended lock, not the
 * expected exit path.
 */

// (1) Silence error path. Install BEFORE any import so even a syntax error in
// the main module exits 0 silently.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// (2) Kill switch. Env vars are available without imports — cheapest possible
// short-circuit, and it must short-circuit before the import so a corrupted
// main module cannot defeat it.
if (process.env.DRUUMEN_SESSIONS_DB_DISABLED === '1') {
  process.exit(0);
}

// (3) Hard timeout. .unref() so the timer never keeps the event loop alive
// past the hook's natural completion. All IO downstream is async (spawn-based
// git probe, promise-based storage), so this timer can actually fire.
setTimeout(() => process.exit(0), 1000).unref();

// (4) NOW it is safe to import the real main. Any import-time failure bubbles
// to the uncaughtException handler installed at step 1 → exits 0 silently.
import('./sessions-db-user-prompt-main.mjs').catch(() => process.exit(0));
