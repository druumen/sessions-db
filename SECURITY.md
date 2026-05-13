# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ (current development line) |
| < 0.1.0 | ❌ (pre-publish) |

Druumen Sessions DB follows semver `0.x.y` semantics: within `0.1.x`, security fixes ship as patch bumps; breaking-change fixes ship as `0.2.0`.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue.** This repository disables Issues, but please also do not email the maintainers directly via personal addresses.

Send vulnerability reports to:

📧 **`security@druumen.com`**

Include:

1. A clear description of the vulnerability and its potential impact.
2. Steps to reproduce (or a proof-of-concept) — sanitize any real session data, transcripts, or credentials before sharing.
3. Affected version(s) of `@druumen/sessions-db`.
4. Your preferred attribution (full name, handle, organization) or `anonymous` if you prefer.

We will acknowledge receipt within **5 business days** and aim to ship a fix or coordinate a disclosure timeline within **30 days** for high-severity issues.

## Scope

In-scope:

- `@druumen/sessions-db` library API and CLI
- `sessions-db-session-start.mjs` hook script
- JSONL event log integrity (events.jsonl, projection.json)
- Identity resolution / parent-candidate algorithms
- First-prompt sanitization correctness

Out-of-scope:

- Vulnerabilities in transitive npm dependencies (please report upstream first; we will coordinate)
- Issues in the Claude Code product itself (report to Anthropic)
- Druumen Cockpit (separate Apache 2.0 project; will mirror to `druumen/cockpit` once split)
- Misconfiguration of user-side `~/.claude/settings.json` hooks

## Coordinated Disclosure

We follow a 30-day coordinated disclosure window from the initial report. After a fix ships, we will publish a CVE (where applicable) and credit reporters in the changelog unless anonymity is requested.

## Supply-Chain Posture

This package is published under controls inherited from the [Druumen npm-publish-readiness](https://github.com/druumen) baseline (cockpit Phase 3 D15 spec):

- ✅ CI-only publish from `gitlab.tinfant.org/druumen/sessions-db` runners
- ✅ npm `publishConfig.provenance: true` (sigstore OIDC attestation)
- ✅ npm `@druumen` organization-wide 2FA `auth-and-writes`
- ✅ `package.json` `files` whitelist (no `.npmignore` blacklist drift)
- ✅ `npm pack --dry-run` inventory grep (no `*.map`, no raw source, no test fixtures with private data)
- ✅ `RELEASING.md` rollback / deprecate / yank runbook

If you suspect a supply-chain compromise (impersonator packages, typosquats, malicious release), please escalate immediately via the security contact above.
