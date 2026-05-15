# Changelog

All notable changes to `@druumen/sessions-db` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-15

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
- **Cross-platform**: macOS / Linux / Windows all supported and
  CI-gated. Linux runs on GitLab `test-linux` (Node 20). Windows runs
  on GitHub Actions `windows-latest` (Node 22) on the public mirror
  `github.com/druumen/sessions-db`; the mirror is pushed automatically
  by the GitLab `mirror-to-github` job on every master / tag / fix-or-
  feat-branch push, so Windows CI feedback round-trips in under 30
  minutes during active iteration.

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
- (none specific to platform support — see Cross-platform note above for
  current CI coverage.)

### Supply chain

- **Releases are CI-published only**; no local `npm publish` from
  maintainer laptops. See [`RELEASING.md`](RELEASING.md) for the full
  procedure.
- **v0.1.0 (bootstrap)** publishes from GitLab CI (`publish-npm` job)
  using a one-time `NPM_TOKEN_BOOTSTRAP` Granular Access Token (48h
  expiry, `@druumen` scope, masked + protected + environment-scoped
  variable, revoked immediately after publish).
- **v0.1.1 onwards** publish from GitHub Actions
  (`.github/workflows/publish.yml`) via npm **OIDC trusted publishing**
  — no long-lived secrets, short-lived OIDC tokens validated by npm
  registry on each publish — and emit **npm provenance** attestations
  (SLSA-style cryptographically signed build attestations). Consumers
  can verify with `npm view @druumen/sessions-db --json | jq .dist.attestations`.
- **Tarball `files` whitelist**: only `lib/`, `cli/`, `types/`,
  `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md`, `package.json` are
  packed. Tests, fixtures, and dev-only state are excluded by an
  explicit allowlist (not `.npmignore` blocklist).
- **Account hardening**: maintainer npm account is 2FA-required for
  both login and publish.

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

### Day 2.5 — 2026-05-12 (monorepo extraction)

- Package history extracted from the Druumen monorepo
  (`drummen.com_cn/packages/sessions-db/`) to a new standalone repo
  `gitlab.tinfant.org/druumen/sessions-db` via `git-filter-repo` so
  the public OSS dependency does not require exposing the private
  monorepo. Apache 2.0 license. History preserved.
- Monorepo MR !80 strips `packages/sessions-db/` in-tree and adds
  sibling-path resolution to `scripts/sessions-db.mjs` +
  `scripts/hooks/sessions-db-session-start.mjs` so production hooks
  installed via `~/.claude/settings.json` continue to fire without
  re-wiring (resolve to `../../sessions-db/cli/sessions-db.mjs`).
- GitHub mirror `github.com/druumen/sessions-db` set up via GitLab CI
  `mirror-to-github` job (image: `alpine/git`, fine-grained PAT,
  master + tags + `fix/*` + `feat/*` branch mirroring for iteration).

### Day 6 — 2026-05-14 (Windows CI)

- GitHub Actions `windows-latest` workflow added (`Windows CI`).
  First run exposed **12 Windows-specific failures** in test
  scaffolding (4 git-context + 4 concurrency NTFS + 3 path
  normalization + 1 init errno shape). Production library/hook code
  was unchanged — 0 lines touched — confirming the production code
  was already cross-platform-portable.
- Test-only fixes:
  - `pathToFileURL` for spawned-child `node --input-type=module` inline
    imports (`lock.test.mjs`, `storage.test.mjs`) — Windows requires
    `file://` URLs, not absolute paths.
  - `realpathSync.native` for Windows 8.3 short-name resolution in
    `mkTmp` helpers (`git-context.test.mjs`) — `RUNNER~1` collapses
    to `runneradmin`.
  - `normPath` / `assertPathEq` helper for case-insensitive
    slash-normalized path comparison (`git-context.test.mjs`) —
    Windows is case-preserving but case-insensitive at the API.
  - `endsWith(sep + ".git")` (or `'/.git'`) instead of `endsWith('/.git')`
    for git common-dir separator variance.
  - Skip hard-timeout shebang tests on Windows (fake bash binary
    won't execute under cmd.exe / pwsh).
  - Skip POSIX `chmod 0o555` permission test on Windows (NTFS does
    not honor POSIX mode bits — contract still verified on POSIX).
  - `tsc.cmd` shim + `shell: true` for `spawnSync` in
    `types-smoke.test.mjs` — npm installs the .cmd shim on Windows,
    and spawnSync needs a shell to resolve it.
- `paths.test.mjs`: relaxed exact-equality to `endsWith` for
  `.dru-code` filesystem root ascend (Windows backslash separator).
- `.gitlab-ci.yml` `test-linux` + `mirror-to-github` rules expanded
  to `fix/*` + `feat/*` (so the mirror job fires for iteration
  branches, enabling sub-30min Windows CI feedback loop).
- `.github/workflows/sessions-db-windows.yml` push trigger expanded
  to `master` + `fix/**` + `feat/**`.
- 3 iteration rounds, all under 1 day. Final state: master `708a02e5`
  green on both GitLab `test-linux` and GitHub Actions Windows CI.

### Day 7 — 2026-05-14 (supply-chain controls)

- `RELEASING.md`: operator playbook for publishing (bootstrap path +
  OIDC path + rotation policy + emergency yank procedure).
- `.gitlab-ci.yml` `publish-npm` job: bootstrap path for v0.1.0,
  uses `NPM_TOKEN_BOOTSTRAP` masked + protected variable, version
  sanity check against tag, manual-trigger gate, `.npmrc` cleanup.
- `.github/workflows/publish.yml`: OIDC publish workflow for v0.1.1+
  releases, uses `id-token: write` + `--provenance` flag for npm
  attestations. Inactive until trusted publisher configured on npm
  web (Bootstrap step 7).
