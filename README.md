# @druumen/sessions-db

Cross-session traceability for [Claude Code](https://claude.com/claude-code).

## What it does

Records every Claude Code session start (cwd, branch, transcript file,
sanitized first prompt) into a local JSONL event log + projection cache.
Provides 3-priority identity reconciliation across forks, resumes, and
hub-spoke (sub-agent) relationships, so you can find related sessions
across days and worktrees without losing the thread.

**Local-only**: no network egress. All data stays on your machine.

## Installation

```bash
npm install @druumen/sessions-db
```

Requires Node.js 18 or newer. Zero runtime dependencies.

## Quick start

### Library API

```js
import {
  initProjection,
  loadProjection,
  watchProjection,
  setAlias,
  setParent,
  closeSession,
  runSweep,
} from '@druumen/sessions-db';

// 1. Bootstrap storage at .dru-code/ in current cwd. Idempotent — safe
//    to call on every app start.
const init = await initProjection({ rootPath: process.cwd() + '/.dru-code' });
if (!init.ok) throw new Error(init.error);

// 2. Load the current projection (sessions + meta).
const projection = await loadProjection({ rootPath: init.paths.eventsJsonl.replace(/\/[^/]+$/, '') });
console.log(Object.keys(projection.sessions).length, 'sessions');

// 3. Watch for changes (debounced 80ms).
const watcher = watchProjection(rootPath, (event) => {
  console.log('changed:', event.type);
});
// Later: watcher.dispose();

// 4. Mutate via the operations API. Each call returns
//    { ok: true, event_id } or { ok: false, error }.
await setAlias({ stableId: 'sess_xxx', alias: 'my session', rootPath });
await setParent({ childId: 'sess_xxx', parentId: 'sess_yyy', rootPath });
await closeSession({
  stableId: 'sess_xxx',
  outcome: 'done',
  reason: 'shipped',
  rootPath,
});

// 5. Sweep activity_state transitions (active → idle → archived).
const sweep = await runSweep({ rootPath, dryRun: true });
console.log(sweep.transitions.length, 'pending transitions');
```

All operations are lock-safe (single-writer through an exclusive-create
lockfile) and idempotent at the projection level. Errors return as
`{ ok: false, error }` rather than throwing — system-class failures (disk
full, permission denied) and business-class failures (cycle, missing
session) share the same shape.

### CLI

```bash
npm install -g @druumen/sessions-db
sessions-db --help

sessions-db find --limit 10                   # list recent sessions
sessions-db tree sess_019e0f2d-c6e3...        # ancestry / descendants
sessions-db alias sess_019e0f2d-c6e3 "label"  # human-readable alias
sessions-db link sess_xxx --task feat-foo.md  # link to ticket / project
sessions-db link-parent sess_child sess_parent
sessions-db close sess_xxx --outcome done --reason "shipped"
sessions-db rebuild                            # rebuild projection from events
sessions-db sweep --dry-run                    # preview activity transitions
```

The CLI is the same surface as the library API; both write through the
same primitives, so a workflow that mixes hook-driven CLI commands with
programmatic library calls observes a consistent projection.

### Hook setup (Claude Code SessionStart)

Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/node_modules/@druumen/sessions-db/cli/sessions-db-session-start.mjs",
        "timeout": 5
      }]
    }]
  }
}
```

The hook is bootstrap-safe by design:

- Kill switch: set `DRUUMEN_SESSIONS_DB_DISABLED=1` to no-op the hook
  without removing it from settings.
- 2-second hard timeout on every operation; the hook always exits 0 so
  it never blocks Claude Code start, even on disk full / permission
  denied / lockfile contention.
- Errors are logged to stderr (visible in Claude Code's session log)
  but never surfaced as user-facing failures.

## Path resolution

When you don't pass an explicit `rootPath`, sessions-db walks a 5-priority
chain. First hit wins:

1. `opts.rootPath` — explicit caller arg (highest priority).
2. `DRUUMEN_SESSIONS_DB_ROOT` — env var override (cockpit Setup Wizard,
   CI matrix runs, ops incident pinning).
3. cwd-ascend (≤12 levels) for an existing
   `tickets/_logs/sessions-db.json` — preserves the druumen-monorepo
   experience: any sessions-db command from anywhere inside the worktree
   finds the canonical root.
4. cwd-ascend (≤12 levels) for an existing `.dru-code/sessions-db.json`
   — the new convention for fresh installs that have already been
   initialized once.
5. Default: `<cwd>/.dru-code/` — what fresh `initProjection({})` lands
   when no existing storage is found. Cockpit marketplace's first
   install creates this dir.

The ascend bound caps the worst-case stat budget at 24 (two candidate
file checks × 12 levels) before falling through to the default — the
resolver never accidentally walks to `/` on a slow networked mount.

The same three filenames are used at every layout:

```
<root>/sessions-db-events.jsonl   # append-only SSoT
<root>/sessions-db.json           # projection cache
<root>/sessions-db.json.lock      # exclusive-create lockfile
```

## Privacy

`first_prompt_preview` stores a sanitized 200-char excerpt of the first
user message in each session, so operators can recognize sessions in
the projection without re-opening transcripts. Sanitization strips:

- IDE-injected wrappers: `<ide_opened_file>`, `<ide_selection>`
- Slash command wrappers: `<command-name>`, `<command-message>`,
  `<command-args>`
- System reminders: `<system-reminder>`, `<system>`, `<thinking>`
- Tool-use blocks: `<tool_use>`, `<tool_result>`, `<parameter>`,
  `<function_calls>`

NFKC normalization is applied **before** stripping so fullwidth-bracket
splice attacks (e.g. `＜system-reminder＞`) cannot bypass the redactor.
The strip is double-pass — when removing one wrapper exposes a fresh
inner wrapper, the second pass catches it. Truncation is UTF-16
codepoint-safe (200 codepoints, not 200 bytes) so multi-byte characters
are not split mid-glyph.

### Privacy opt-out (available in 0.1.0)

To disable preview storage entirely — useful for marketplace audits,
shared-machine deployments, or any user who'd rather not persist the
human-readable first prompt:

**Library API:**

```js
import { recordSessionSeen } from '@druumen/sessions-db';

await recordSessionSeen({
  claudeSessionId,
  // ...other opts...
  storeFirstPrompt: false,   // payload.first_prompt_preview = null
});
```

**Hook env var (Claude Code SessionStart):**

```bash
DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0 \
  claude code   # or whatever spawns the hook
```

`'0'` and `'false'` (case-insensitive) opt out; anything else (or unset)
keeps the default. Default is `true` — backward compatible with the
0.1.0-dev preview behavior.

Fingerprints (`first_human_prompt_v1`, `lineage_prefix_v1`) and
`transcript_file` metadata are intentionally **not** affected by this
opt-out, so identity reconciliation (resume / fork detection) keeps
working for opt-out users.

## Schema

The events log (`sessions-db-events.jsonl`) is the single source of
truth; the projection (`sessions-db.json`) is a derivable cache. Run
`sessions-db rebuild` at any time to regenerate the projection from
events — useful after manual events-log inspection / surgery.

`schema_version: 2` is the stable contract for the entire 0.1.x line.
Reducers stay backward-compatible: new optional fields may appear in
0.1.x minor releases, but no existing field is removed or repurposed.
Schema-breaking changes (rename, type change, removal) ship at 0.2.0+.

## Versioning

0.x semver:

- **Patch** (0.1.x): bug fixes, doc, internal refactors. No API change.
- **Minor** (0.x.0): additive only. New library exports, new CLI
  subcommands, new optional projection fields. Existing surface is
  unchanged.
- **Major** (1.0.0): commits the API as stable. Until then, treat 0.x as
  "settling" — pin `>=0.1.0 <0.2.0` in your `package.json` if you want
  field-additive but no breaking changes inside the 0.1 line.

Schema-breaking changes always coincide with at least a 0.x minor bump
(0.2.0+) and ship with a documented migration path.

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Roadmap

- **0.1.0** (current): Library + CLI + hook + 3-priority identity +
  cross-platform (macOS / Linux verified in CI; Windows pending runner) +
  privacy opt-out (`storeFirstPrompt: false` /
  `DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0`).
- **0.2.0** (TBD): parent_candidate auto-promote heuristic, outcome
  auto-derive on `/task-done` linkage.
- **0.3.0** (TBD): Multi-machine sync (schema_version=3 break,
  documented migration).
- **0.4.0+** (TBD): Web UI / VS Code Sessions panel via
  [Druumen Cockpit](https://druumen.com).
