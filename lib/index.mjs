/**
 * @druumen/sessions-db — public library entry.
 *
 * This file is intentionally a stub on Day 1. The full public API surface
 * (re-exports of the curated set of functions from storage.mjs / projection.mjs
 * / sweep.mjs / identity.mjs / sanitize.mjs / transcript.mjs / git-context.mjs)
 * is filled in Day 3, after we settle which symbols belong on the public
 * boundary vs. internal helpers.
 *
 * For now, downstream consumers should import directly from the individual
 * modules (e.g. `@druumen/sessions-db/lib/storage.mjs`) — but this is NOT a
 * stable surface and will be hoisted to a curated `index.mjs` re-export in
 * Day 3 so v0.1.0 can ship a single import path.
 *
 * The CLI and hook entrypoints (cli/sessions-db.mjs, cli/sessions-db-session-
 * start.mjs) are independent of this file and continue to work today.
 */

export {}; // placeholder so the file is a valid ES module with zero exports
