# Changelog

All notable changes to `@druumen/sessions-db` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Day 1 — 2026-05-10)

- Initial npm package skeleton: `lib/`, `cli/`, `__tests__/{unit,cli,hook,git-context}/`.
- `package.json` with `name=@druumen/sessions-db`, `version=0.0.1-dev`,
  `main`, `types`, `bin`, `exports`, `files`, `engines`, `scripts.test`.
- Apache 2.0 `LICENSE` + `NOTICE` (Tinfant Tech / Druumen).
- README outline + this CHANGELOG.
- Backward-compat thin wrappers at `scripts/sessions-db.mjs` and
  `scripts/hooks/sessions-db-session-start.mjs` so existing
  `~/.claude/settings.json` hook paths and druumen monorepo CLI
  invocations continue to work without re-wiring.
- Re-export entry `lib/index.mjs` (stub — full public surface filled Day 3).

### Notes (Day 1)

- Pure file-move + import-path update — no logic change.
- 355 tests pass (matches pre-restructure baseline).
- Zero new npm dependencies.

### Added (Day 2 — 2026-05-10)

- `tsconfig.sessions-db.json` at worktree root — `allowJs` +
  `emitDeclarationOnly` pipeline. Source files stay `.mjs` (no large
  rewrite); existing JSDoc augmented where needed.
- `lib/types.mjs` — central `@typedef` source for the public type
  vocabulary (SessionStableId, ClaudeSessionId, EventId, Iso8601,
  ActivityState, Outcome, IdentitySource, IdentityConfidence, EventOp,
  TranscriptFile, IdentityResolution, ParentCandidate, KnownSession,
  ProjectionMeta, Projection, SessionEvent).
- `types/*.d.mts` (auto-emit, 11 files mirroring `lib/*.mjs`) +
  `types/index.d.ts` (hand-crafted curated entry that re-exports the
  public type names so cockpit can `import type { KnownSession,
  Projection } from '@druumen/sessions-db'`).
- `__tests__/types-smoke/` — cockpit-style import smoke
  (`cockpit-import.ts` + dedicated `tsconfig.json`) wrapped by
  `types-smoke.test.mjs` so the existing `npm test` exercises the
  type surface (4 sub-tests).
- `package.json`: `devDependencies.typescript` (^5.4.0 — devDep only,
  zero runtime deps preserved), `scripts.build:types`,
  `scripts.check:types-smoke`, `scripts.prepublishOnly`.

### Notes (Day 2)

- 359 tests pass (Day 1 baseline 355 + 4 new types-smoke sub-tests).
- Zero new runtime dependencies (typescript is devDep only).
- `lib/index.mjs` stays a Day-1 stub; the curated `types/index.d.ts`
  is types-only and Day-3 will fill the runtime entry.

## [0.1.0] — TBD (publish day)

First public release. Day 5 will replace this header date when the
package ships to npm.
