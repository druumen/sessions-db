# Druumen Sessions DB

JSONL-as-SSoT session traceability for Claude Code workflows. Auto-registers sessions via SessionStart hook, supports hub-spoke parent tracking, three-priority identity lookup, and weekly sweep archival.

> **🪞 This is a read-only mirror.** Canonical source lives at `gitlab.tinfant.org/druumen/sessions-db` (private). This GitHub mirror exists solely so the public Apache 2.0 source is discoverable and so cross-platform CI matrices (Windows / macOS / Linux) can be exercised on free hosted runners.
>
> **Do not open issues or PRs here.** They will be closed without review. For bug reports, feature requests, or contributions:
> - 📧 Email: `security@druumen.com` (security issues only) / `hello@druumen.com` (general)
> - 🌐 Project home: https://druumen.com

## Install

```bash
npm install @druumen/sessions-db
```

Status: **planning publish 0.1.0 (~2026-05-15–18)**. Package not yet on npm registry as of repository mirror creation.

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Security

See [SECURITY.md](./SECURITY.md) for the responsible disclosure policy.

## Repository conventions

| Branch | Purpose |
|--------|---------|
| `main` | Mirror metadata only (this README, LICENSE, NOTICE, SECURITY) |
| `master` | Mirrored from canonical GitLab `master` |
| `feat/*` | Mirrored feature branches (read-only, do not push here) |

The `main` branch contains only the mirror metadata so that `github.com/druumen/sessions-db` has a stable, self-explanatory landing page even when the canonical branches are in flux.
