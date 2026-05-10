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

### Notes

- Pure file-move + import-path update — no logic change.
- 355 tests pass (matches pre-restructure baseline).
- Zero new npm dependencies.

## [0.1.0] — TBD (publish day)

First public release. Day 5 will replace this header date when the
package ships to npm.
