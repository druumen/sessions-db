# Releasing @druumen/sessions-db

This document is the operator playbook for cutting and publishing a release
of `@druumen/sessions-db` to the npm registry.

There are two release paths:

1. **Bootstrap path** — used **once**, for the very first publish (`0.1.0`).
   Authenticates with a one-time `NPM_TOKEN_BOOTSTRAP` from GitLab CI.
   Required because npm web's **trusted publisher** feature can only be
   configured *after* the package exists on the registry.

2. **OIDC path** — used for **every release after `0.1.0`**.
   Authenticates with short-lived OIDC tokens from GitHub Actions
   (`windows-latest` mirror), no long-lived secrets stored anywhere.
   Emits npm provenance (cryptographically signed build attestations).

The bootstrap path is intentionally one-shot — the token is revoked the
moment `0.1.0` lands on the registry. Subsequent releases **must** go
through the OIDC path. There is no fallback to a long-lived NPM_TOKEN.

---

## TL;DR — release checklist (every release)

1. Verify CI green on master (GitLab `test-linux` + GitHub Actions Windows).
2. Bump version in `package.json` (semver — `npm version patch|minor|major`).
3. Move the new section in `CHANGELOG.md` from `Unreleased` to a dated header.
4. Open a MR (release-prep), get it green + merged.
5. Tag `vX.Y.Z` on master and push the tag to GitLab.
6. The GitLab CI `publish-npm` job (Bootstrap path) or GitHub Actions
   `publish.yml` (OIDC path) picks up the tag and publishes.
7. Verify the tarball on npm: `npm view @druumen/sessions-db@X.Y.Z`.
8. Verify provenance (OIDC path only):
   `npm view @druumen/sessions-db@X.Y.Z --json | jq .dist.attestations`

Pre-flight items that must be true before tagging:

- `package.json` `version` matches the tag (no `-dev` suffix).
- `CHANGELOG.md` has a section for this version with a real date (not "TBD").
- `npm pack --dry-run` output reviewed (under 200 KB / 70 files; only
  `lib/`, `cli/`, `types/`, `LICENSE`, `NOTICE`, `README.md`,
  `CHANGELOG.md`, `package.json`).
- No uncommitted local changes (`git status` clean).
- **Protected refs audit** — GitLab tinfant project must have all of:
  - `master` branch (push + merge: Maintainers)
  - `v*` tag (create: Maintainers) — **without this, the v* tag
    pipeline cannot read protected variables like `GITHUB_MIRROR_TOKEN`,
    and `mirror-to-github` fails on the publish pipeline.** Verify with:
    ```bash
    glab api projects/druumen%2Fsessions-db/protected_tags | jq '.[].name'
    ```
    Add via Settings → Repository → Protected tags → Pattern `v*` →
    Allowed to create: Maintainers.
- **OIDC publish prerequisites** (Path 2 / `v0.1.1+`):
  - `package.json` `repository.url` MUST point to
    `git+https://github.com/druumen/sessions-db.git` — npm registry
    rejects (HTTP 422) any provenance-signed publish where the
    package.json `repository.url` doesn't match the GitHub repo that
    signed provenance. The GitLab tinfant URL is the dev SSoT but
    NOT what npm sees. Verify with:
    ```bash
    node -p "require('./package.json').repository.url"
    # → expect: git+https://github.com/druumen/sessions-db.git
    ```
  - GitHub Actions runner must use `npm >= 11.5.1` for OIDC trusted
    publisher token-exchange (Node 20 ships 10.8.x). The
    `publish.yml` workflow has an `npm install -g npm@latest` step
    that handles this. Don't remove it.

---

## Path 1 — Bootstrap publish (one-time, for `0.1.0` only)

**This path is used ONCE.** Skip to "Path 2 — OIDC publish" for all releases after `0.1.0`.

### Why this exists

npm's trusted-publisher web UI requires the package to already exist on the
registry before you can link a GitHub Actions workflow as the trusted
publisher. So the very first publish bootstraps the package onto the
registry using a granular access token, then we tear that token down and
switch to OIDC forever after.

### Operator (cockpit user) one-time steps

0. **Release-prep MR** (before any tagging — fails fast if you skip this).

   `package.json` ships on master as `0.0.1-dev` and `CHANGELOG.md`'s
   `0.1.0` header reads `TBD (publish day)`. Both must be updated
   **before** the tag is pushed, or the `publish-npm` job will refuse
   to publish.

   ```bash
   cd /path/to/sessions-db
   git checkout master
   git pull --ff-only
   git checkout -b release/v0.1.0
   npm version 0.1.0 --no-git-tag-version
   # Edit CHANGELOG.md: replace "## [0.1.0] — TBD (publish day)"
   # with "## [0.1.0] — YYYY-MM-DD" (use today's date).
   git commit -am "release: v0.1.0"
   git push -u origin release/v0.1.0
   glab mr create --target-branch master --title "release: v0.1.0" --remove-source-branch
   ```

   Wait for CI green + merge. Then continue to step 1.

1. **Generate Granular Access Token on npm**

   - Login to <https://www.npmjs.com> as the publisher account.
   - Account → Access Tokens → **Generate New Token** → **Granular Access Token**.
   - Configuration:
     - **Token name**: `sessions-db-bootstrap-0.1.0`
     - **Expiration**: **48 hours** (max needed; will be revoked sooner)
     - **⚠️ Bypass two-factor authentication (2FA)**: **MUST be checked**.
       npm removed Classic Automation tokens in November 2025; only
       Granular Access Tokens are accepted. Granular tokens require an
       OTP at publish time **even when the account is in `auth-only`
       2FA mode**, unless this checkbox is explicitly opted in. Without
       this opt-in, `npm publish` from CI fails with `EOTP` (we hit
       this 5 times during 0.1.0 bootstrap before discovering the
       checkbox).
     - **Allowed IP ranges**: leave blank (CI runner IP is dynamic).
     - **Scopes**: `@druumen` only
     - **Packages**: `@druumen/sessions-db` only (or "no packages yet" if the
       UI requires existing packages — granular tokens allow this)
     - **Permissions**: **Read and Write**
   - Copy the token (you only see it once).

2. **Add to GitLab CI variables (1Password share recommended)**

   - GitLab: druumen/sessions-db → Settings → CI/CD → Variables → **Add Variable**
   - **Key**: `NPM_TOKEN_BOOTSTRAP`
   - **Value**: `npm_xxxxx...` (from step 1)
   - **Visibility**: **Masked**
   - **Flags**: **Protect variable** (so it's only available to protected branches/tags)
   - **Environment scope**: `npm-publish` (matches the `environment:` field in `.gitlab-ci.yml`)
   - **Description**: `One-time bootstrap token for sessions-db 0.1.0 publish — REVOKE after publish lands.`

3. **Tag and push**

   ```bash
   cd /path/to/sessions-db
   git checkout master
   git pull --ff-only
   git tag v0.1.0
   git push origin v0.1.0
   ```

   This triggers GitLab CI pipeline with stages: `test → deploy → publish`.
   The `publish-npm` job is **manual** (requires operator click in the GitLab
   pipeline UI) so accidental tag pushes do not auto-publish.

4. **Click "Run" on publish-npm in GitLab pipeline UI**

   - Pipeline view: <https://gitlab.tinfant.org/druumen/sessions-db/-/pipelines>
   - Click on the pipeline for tag `v0.1.0`, then click "Run" on `publish-npm`.
   - Watch the log. Successful publish output ends with:
     `+ @druumen/sessions-db@0.1.0`

5. **Verify on npm**

   - <https://www.npmjs.com/package/@druumen/sessions-db>
   - `npm view @druumen/sessions-db@0.1.0` from any terminal.

6. **REVOKE bootstrap token immediately** (do not wait for 48h expiry)

   - npm web → Account → Access Tokens → find `sessions-db-bootstrap-0.1.0`
     → **Revoke**.
   - GitLab: Settings → CI/CD → Variables → delete `NPM_TOKEN_BOOTSTRAP`.

7. **Configure trusted publisher on npm web** (enables Path 2 for `0.1.1+`)

   - npm web → `@druumen/sessions-db` → **Settings** → **Trusted Publishers**
     → **Add Trusted Publisher** → **GitHub Actions**.
   - **Configuration**:
     - **Organization or user**: `druumen`
     - **Repository**: `sessions-db`
     - **Workflow filename**: `publish.yml`
     - **Environment** (optional but recommended): `npm-publish`
   - Save. The next release will publish via Path 2 (OIDC).

### Bootstrap path security notes

- The bootstrap token has **48h max lifetime**, narrow `@druumen` scope,
  and is **revoked immediately after publish lands**.
- GitLab CI variable is **masked + protected + environment-scoped** to
  `npm-publish` (which only the `publish-npm` job uses).
- The bootstrap token is **NOT** copied anywhere else (no laptops, no
  password manager beyond the 1Password share used for the GitLab variable
  upload — and that share is deleted post-publish).
- If the bootstrap publish fails after the token was uploaded, **revoke
  the token before retrying** and generate a fresh one.

---

## Path 2 — OIDC publish (every release after `0.1.0`)

This is the steady-state path. No long-lived secrets are stored anywhere.

### Prerequisites (one-time, completed during bootstrap)

- npm trusted publisher configured for `druumen/sessions-db` /
  `publish.yml` / `npm-publish` environment (set up in Bootstrap step 7).
- GitHub Actions has access to the canonical content (mirror pushes to
  `github.com/druumen/sessions-db` on every master / tag push — see
  GitLab `mirror-to-github` CI job).

### Release procedure

1. **Pre-flight checks** (same as TL;DR — package.json version, CHANGELOG
   date, `npm pack --dry-run` review, clean working tree).

2. **Open release-prep MR**

   ```bash
   git checkout -b release/vX.Y.Z
   npm version X.Y.Z --no-git-tag-version   # updates package.json + lockfile
   # edit CHANGELOG.md: move Unreleased → [X.Y.Z] — YYYY-MM-DD
   git commit -am "release: vX.Y.Z"
   git push -u origin release/vX.Y.Z
   glab mr create --target-branch master --title "release: vX.Y.Z" \
     --remove-source-branch
   ```

   Wait for `test-linux` + Windows CI green, then merge.

3. **Tag on master and push to GitLab**

   ```bash
   git checkout master
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. **GitLab CI mirrors the tag to GitHub**

   The `mirror-to-github` job (image: `alpine/git`) pushes `HEAD:refs/heads/master`
   plus `--tags` to `github.com/druumen/sessions-db`. The tag push on GitHub
   triggers the `publish.yml` workflow.

5. **GitHub Actions `publish.yml` publishes via OIDC**

   - The workflow runs `npm publish --provenance`.
   - npm registry validates the OIDC token against the configured trusted
     publisher (org=druumen, repo=sessions-db, workflow=publish.yml,
     environment=npm-publish).
   - On success: tarball is published **with provenance attestation**.
   - Watch the run at <https://github.com/druumen/sessions-db/actions>.

6. **Verify**

   ```bash
   npm view @druumen/sessions-db@X.Y.Z
   npm view @druumen/sessions-db@X.Y.Z --json | jq .dist.attestations
   # Expect: { "url": "https://registry.npmjs.org/-/npm/v1/attestations/...",
   #          "provenance": { "predicateType": "https://slsa.dev/provenance/v1" } }
   ```

7. **Post-release housekeeping**

   - On master, optionally bump version to next `-dev` (e.g. `0.1.1-dev`) in
     a follow-up MR. This is optional; not having a `-dev` suffix between
     releases is also fine.

---

## Rotation policy

### GitHub Mirror PAT (`GITHUB_MIRROR_TOKEN`)

- **Type**: GitHub fine-grained Personal Access Token (cockpit user's account).
- **Scope**: Resource owner = `druumen` org, repository access = only
  `druumen/sessions-db`, permissions = Contents R/W + Metadata R + Workflows R/W.
- **Expiry**: 90 days max.
- **Rotation**: Set a calendar reminder 75 days after issue. Generate new
  token, update `GITHUB_MIRROR_TOKEN` GitLab CI variable, verify next
  master push triggers successful mirror.
- **TODO** (follow-up enhancement, not blocking 0.1.0): add a
  `schedule:`-triggered GitLab CI job that runs weekly, performs a
  `git ls-remote` dry-run against the GitHub mirror using the token, and
  fails fast if auth is rejected (expired / revoked / scope-changed).
  Catches silent PAT expiry before the next master push (which might be
  weeks away on slow days).

### npm trusted publisher (OIDC, no token)

- Configured once during Bootstrap step 7. No expiry — npm rotates the
  underlying OIDC trust on its side. Validity of OIDC publish depends on
  the GitHub Actions workflow filename matching the trusted publisher
  config. **Do not rename `publish.yml` without first updating npm web.**

### NPM_TOKEN_BOOTSTRAP

- Single-use, 48h max lifetime, revoked immediately after `0.1.0` publish.
- Should NOT exist in the registry, GitLab variables, or any password
  manager after `0.1.0` is live.

---

## Emergency: yanking a release

If a release contains a security issue, secret leak, or critical bug:

```bash
# Deprecate (keeps the tarball, marks it deprecated)
npm deprecate @druumen/sessions-db@X.Y.Z "Security: see SECURITY.md / GHSA-..."

# Unpublish (subject to npm unpublish policy — see notes below)
npm unpublish @druumen/sessions-db@X.Y.Z
```

**npm unpublish policy** (see <https://docs.npmjs.com/policies/unpublish/>):

- Allowed only within **72 hours** of publish.
- **NOT allowed** if any other public-registry package depends on this
  version. If even one downstream dependent exists, `npm unpublish`
  refuses; you must use `npm deprecate` instead.
- Once unpublished, the version string **can never be reused** — the
  next release must bump to a higher version. Do not unpublish for
  cosmetic reasons.

When unpublish is not viable, the workflow is: `npm deprecate <bad>` +
publish a fix release immediately (`X.Y.Z+1`) + file a security advisory
on the GitHub mirror.

Document the yank in `CHANGELOG.md` with a brief reason and link to the
fix release. File a security advisory on the GitHub mirror if it was a
vulnerability.

---

## Tagging convention

- Annotated tags only: `git tag -a vX.Y.Z -m "release: vX.Y.Z"` (or plain
  `git tag vX.Y.Z` works since CI cares about the ref name).
- Tag format: **`vX.Y.Z`** strict semver, no pre-release suffix on master.
- Pre-release tags (`vX.Y.Z-alpha.N`) are allowed but will only publish if
  the `publish-npm` job rule is widened — currently the rule is
  `/^v\d+\.\d+\.\d+$/` (no pre-release tags trigger publish).

---

## File ownership

- This file (`RELEASING.md`) — release engineer / cockpit user.
- `.gitlab-ci.yml` `publish-npm` stage — release engineer.
- `.github/workflows/publish.yml` — release engineer.
- `package.json` `version` / `CHANGELOG.md` — feature developer (during
  release-prep MR).

Changes to `publish-npm` or `publish.yml` require a code review from
another maintainer.
