# Changelog

All notable changes to `@druumen/sessions-db` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — TBD (publish day)

First public release. Extracted from the Druumen monorepo as a
standalone, Apache-2.0 licensed npm package with zero runtime
dependencies.

### Added

- **Library API** (one curated entry, `@druumen/sessions-db`):
  `loadProjection`, `watchProjection`, `initProjection`,
  `setAlias`, `linkTask`, `unlinkTask`, `setParent`, `closeSession`,
  `runSweep`, `recordSessionSeen`, `tryUpdateProjection`,
  `rebuildProjection`, `resolveStoragePaths`, plus identity / sanitize /
  uuid / projection-reducer helpers for advanced consumers.
- **CLI** (`sessions-db` binary, 8 subcommands): `find`, `tree`,
  `alias`, `link`, `link-parent`, `close`, `rebuild`, `sweep`.
- **Hook** (`sessions-db-session-start` binary): Claude Code
  `SessionStart` integration; bootstrap-safe (kill switch via
  `DRUUMEN_SESSIONS_DB_DISABLED=1`, 2-second hard timeout, always
  exits 0 — never blocks Claude Code start on storage failure).
- **Identity reconciliation**: 3-priority chain
  (claude_session_id_index → transcript_lineage → fingerprint +
  corroborator). Covers fork / resume / hub-spoke without false-merging
  unrelated sessions.
- **Storage**: append-only JSONL events log as single source of truth +
  JSON projection cache; lock-safe writes via exclusive-create
  lockfile; rebuild-from-events recovery path.
- **Sweep**: `activity_state` auto-maintenance
  (active → idle → archived) driven by configurable thresholds, with
  dry-run preview.
- **Path resolution**: 5-priority chain (explicit arg → env var →
  ascend for `tickets/_logs/` → ascend for `.dru-code/` → default
  `<cwd>/.dru-code/`). Bounded ascend (12 levels max) so the resolver
  never walks to `/` on a slow networked mount.
- **TypeScript types**: hand-curated `types/index.d.ts` re-export hub
  plus auto-emitted `.d.mts` siblings via `tsc --emitDeclarationOnly`
  + JSDoc on the source `.mjs` files. Cockpit and other TS consumers
  can `import type { KnownSession, Projection } from '@druumen/sessions-db'`.
- **Cross-platform**: macOS / Linux supported and exercised; Linux is
  the CI gate (`sessions-db-test-linux`). Windows is supported in code
  (paths use `node:path` join, no shell-out, no POSIX-only syscalls)
  and will be CI-gated once a Windows runner is registered (see Known
  Limitations).

### Privacy

- `first_prompt_preview` sanitization: NFKC normalize → 9 wrapper
  strip categories (IDE / slash-command / system-reminder / tool-use)
  → double-pass (catches splice-injection where stripping one wrapper
  exposes a fresh inner wrapper) → UTF-16 codepoint truncation at 200
  chars (no mid-glyph splits).
- Local-only storage: zero network egress; no telemetry.
- Privacy opt-out: pass `opts.storeFirstPrompt: false` to
  `recordSessionSeen`, or set env var
  `DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0` (or `=false`, case-insensitive)
  to disable preview storage entirely. When opted out the hook still
  computes fingerprints + transcript_files metadata, so identity
  reconciliation (resume / fork detection) keeps working — only the
  human-readable preview field is dropped. Default `true` (backward
  compat with 0.1.0-dev preview behavior).

### Known limitations

- Multi-machine sync is not yet supported (single-machine local-only
  in 0.1.x). Multi-host sync targets 0.3.0 with a documented
  schema_version=3 migration.
- macOS `fs.watch` may emit duplicate events; the library debounces
  internally at 80 ms, so consumers see a single change event per
  logical mutation.
- Windows runner not yet registered on tinfant.org GitLab; the Windows
  job will be added with `allow_failure: true` during initial burn-in
  once a runner is available. Code is path-portable and expected to
  pass on first run, but the contract isn't gated by CI yet.

### Dependencies

- Runtime: zero (only `node:fs`, `node:path`, `node:crypto`, `node:os`,
  and other built-in modules).
- Dev: `typescript` ^5.9.3 (declaration emit only — never bundled into
  the published tarball).

---

## Pre-release iteration (build-time history)

The entries below document day-by-day construction of 0.1.0 inside the
Druumen monorepo. They are kept here as build provenance; downstream
consumers should look at the `[0.1.0]` entry above for the published
contract.

### Day 1 — 2026-05-10

- Initial npm package skeleton: `lib/`, `cli/`,
  `__tests__/{unit,cli,hook,git-context}/`.
- `package.json` with `name=@druumen/sessions-db`, `version=0.0.1-dev`,
  `main`, `types`, `bin`, `exports`, `files`, `engines`, `scripts.test`.
- Apache 2.0 `LICENSE` + `NOTICE` (Tinfant Tech / Druumen).
- README outline + this CHANGELOG.
- Backward-compat thin wrappers at `scripts/sessions-db.mjs` and
  `scripts/hooks/sessions-db-session-start.mjs` so existing
  `~/.claude/settings.json` hook paths and druumen monorepo CLI
  invocations continue to work without re-wiring.
- Re-export entry `lib/index.mjs` (stub — full public surface filled Day 3).
- Pure file-move + import-path update — no logic change. 355 tests pass.

### Day 2 — 2026-05-10

- `tsconfig.sessions-db.json` at worktree root — `allowJs` +
  `emitDeclarationOnly` pipeline. Source files stay `.mjs` (no large
  rewrite); existing JSDoc augmented where needed.
- `lib/types.mjs` — central `@typedef` source for the public type
  vocabulary.
- `types/*.d.mts` (auto-emit, 11 files mirroring `lib/*.mjs`) +
  `types/index.d.ts` (hand-crafted curated entry).
- `__tests__/types-smoke/` — cockpit-style import smoke (4 sub-tests).
- `package.json`: `devDependencies.typescript` (^5.4.0 — devDep only).
- 359 tests pass.

### Day 3 — 2026-05-10

- `lib/operations.mjs` — public write surface
  (`setAlias` / `linkTask` / `unlinkTask` / `setParent` / `closeSession` /
  `runSweep`) with `{ ok, event_id?, error? }` result shape.
- `lib/index.mjs` filled out — curated re-export hub for the v0.1.0
  public surface.
- CLI handlers refactored to consume the library API (single source of
  truth for validation + business invariants).

### Day 4 — 2026-05-10

- `lib/paths.mjs` — 5-priority `resolveStoragePaths` chain (explicit
  arg → env var → tickets/_logs → .dru-code → default).
- `lib/init.mjs` — Day 4 `initProjection({ rootPath })` form for the
  cockpit Setup Wizard's `.dru-code/` flat-layout default.
- `STORAGE_FILENAMES` + `MAX_ASCEND_DEPTH` exported.
- `recordSessionSeen` / `tryUpdateProjection` / `loadProjection`
  updated to delegate to the resolver when no explicit root is given.

### Day 5 — 2026-05-10

- `.gitlab-ci.yml`: `sessions-db-test-linux` job (path-scoped to
  `packages/sessions-db/**`, `tsconfig.sessions-db.json`,
  `.gitlab-ci.yml`). Cross-platform CI gate. Windows runner TODO.
- `README.md`: complete operator + library doc — Installation, Library
  API quick start, CLI reference, Hook setup, 5-priority path
  resolution, Privacy, Schema, Versioning, License, Roadmap.
- `CHANGELOG.md`: this entry (full 0.1.0 inventory + day-by-day
  provenance).
- `npm pack --dry-run` verified clean (lib/cli/types/LICENSE/NOTICE/
  README/CHANGELOG/package.json only; tests/fixtures excluded via
  `files` field).
- End-to-end smoke test: tmpdir cockpit-style integration verifies
  `initProjection` → `loadProjection` → `setAlias` → `setParent` →
  `closeSession` → `runSweep` flow as the published API surface.
- 426 tests pass (Day 4 baseline, no regression).
