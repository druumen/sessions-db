# @druumen/sessions-db

Cross-session traceability for [Claude Code](https://claude.com/claude-code).

> **Repository note**: development happens at
> `gitlab.tinfant.org/druumen/sessions-db` (private to tinfant org —
> file MRs there). The `github.com/druumen/sessions-db` mirror is
> public and is the source-of-truth for npm provenance attestations
> + the consumer-facing "view source" link from
> <https://www.npmjs.com/package/@druumen/sessions-db>. Both are kept
> in sync via GitLab CI's `mirror-to-github` job.

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

sessions-db find --limit 10                   # list recent sessions (structured filters)
sessions-db search "pricing" --json           # free-text search (metadata; AI-friendly)
sessions-db search "RLS regression" --content # also scan transcript text + snippet
sessions-db tree sess_019e0f2d-c6e3...        # ancestry / descendants
sessions-db alias sess_019e0f2d-c6e3 "label"  # human-readable alias (alias channel)
sessions-db names sess_019e0f2d-c6e3          # every name it has had, per channel
sessions-db search "old name" --include-history  # find it under a name it lost
sessions-db link sess_xxx --task feat-foo.md  # link to ticket / project
sessions-db link-parent sess_child sess_parent
sessions-db close sess_xxx --outcome done --reason "shipped"
sessions-db rebuild                            # rebuild projection from events
sessions-db sweep --dry-run                    # preview activity transitions
sessions-db prune                              # report never-used sessions (DRY RUN)
sessions-db prune --yes                        # actually remove them
```

`prune` refuses to delete when its scan of `~/.claude/projects` comes back
empty or reports an error, and names the root it read. That scan is the
only criterion distinguishing a real session nobody resumed from a ghost,
so an empty one would make every never-resumed session look prunable —
the realistic causes are `sudo` / cron / containers changing `HOME`, or a
typo'd `DRUUMEN_CLAUDE_PROJECTS_ROOT`. A dry run still reports, flagged
`disk_scan.trusted: false`. `--accept-untrusted-scan` overrides the
refusal for a machine that genuinely holds no transcripts.

The CLI is the same surface as the library API; both write through the
same primitives, so a workflow that mixes hook-driven CLI commands with
programmatic library calls observes a consistent projection.

### Hook setup (Claude Code)

Two hooks, and you want **both**. Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/node_modules/@druumen/sessions-db/cli/sessions-db-session-start.mjs",
        "timeout": 5
      }]
    }],
    "UserPromptSubmit": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/node_modules/@druumen/sessions-db/cli/sessions-db-user-prompt.mjs",
        "timeout": 5
      }]
    }]
  }
}
```

**Why both.** `SessionStart` fires when a Claude Code process comes up, which is
before the user has said anything — it cannot know the first prompt, and most of
the processes it sees (daemon warm-pool, IDE panel spawns) are never spoken to
at all. `UserPromptSubmit` is what supplies the first prompt, advances the
progress timestamp on every turn, and promotes a session from "a process
started" to "somebody is working here". Without it you get records with a null
preview and a progress time frozen at creation — the pre-0.2.0 behaviour.

Registering only `SessionStart` is safe (deferral is gated on the prompt hook
having actually run, so nothing is silently dropped), just not useful.

Both hooks are bootstrap-safe by design:

- Kill switch: set `DRUUMEN_SESSIONS_DB_DISABLED=1` to no-op both hooks
  without removing them from settings.
- Hard timeout on every operation — 2 s for `SessionStart`, 1 s for
  `UserPromptSubmit` (it runs on every turn, in front of the user). Both always
  exit 0, so neither blocks Claude Code even on disk full / permission denied /
  lockfile contention.
- Nothing is ever written to stderr; a hook that cannot do its job does
  nothing, visibly to no one.

#### Subpath imports `./cli` and `./hook` are ESM-only

The `@druumen/sessions-db/cli` and `@druumen/sessions-db/hook` exports
resolve to `.mjs` entry points and are intended to be **executed as
processes** (via the `bin` field's shim, or invoked directly with
`node <path>`). They are NOT intended for programmatic `require()` /
`import` from a consumer's runtime code.

If you need to run the CLI from your code, spawn it as a child process:

```js
// CJS or ESM consumer — spawn the CLI as a process
import { spawnSync } from 'node:child_process';
spawnSync('npx', ['sessions-db', 'find', '...'], { stdio: 'inherit' });
```

The main library entry (`@druumen/sessions-db`) IS dual-published as
both CJS and ESM and works from either context. Only the bin-style
subpaths are ESM-only.

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

`schema_version: 2` is still the contract in 0.3.0 — every release so far
has added event ops (`session_progress`, `session_prune`, `name_set`) and
optional projection fields, and removed or repurposed nothing.

### Session names

A session is named by several parties, and each one is a **channel**:

| channel | who sets it | `source` | in the display chain |
|---|---|---|---|
| `alias` | `sessions-db alias` (you) | `human` | yes — highest |
| `cc_custom_title` | renamed by hand in Claude Code | `human` ¹ | yes |
| `cc_ai_title` | Claude Code's generated title | `llm` | yes |
| `agent_name` | agent-team badge | `harvest` | **no** — recorded only |
| `first_prompt` | pseudo-channel for `first_prompt_preview` | — | yes — last resort |

`source` is **authorship**, not the collection route: `cc_ai_title` and
`cc_custom_title` both arrive through the same harvesting hook, but one
was written by a model and the other typed by a person.

¹ Claude Code also writes `custom-title` itself when a session is resumed
from the picker (`Resume session <8 hex>`), into the same field a person
types into. That one known shape is recorded as `harvest`; any other
machine-written title on this channel would be indistinguishable from a
typed one and would be recorded as `human`. Known limit of the axis on
this channel.

Three properties are worth knowing before you build on this:

- **The channel list is open.** New namers are added by writing a new
  channel string; nothing enumerates them. The price is a rule every
  reader must honour: **preserve channels you do not recognise**. A
  reader that filtered them would silently delete a newer version's names
  on its next save. Channel and source are bounded (1-64 / 1-32 chars of
  `[A-Za-z0-9._-]`, starting alphanumeric) so an open field cannot become
  an arbitrary payload lane.
- **The projection stores current values only.** One entry per channel,
  plus a `set_count`. History lives in `events.jsonl` and is read back by
  `sessions-db names <id>`, which replays it. Renaming a session 500
  times does not grow the projection, which matters because that file is
  read whole on every refresh.
- **Naming a channel what it is already called is not a rename.** Two
  writes of the same `(value, source)` leave the entry untouched —
  `set_count` does not move and no history entry appears. This is what
  keeps the reducer idempotent: the projection is a fold of an append-only
  log, so the same event legitimately arrives twice (a cold cache is
  rebuilt from a log that already holds it, two hooks race the same
  observation, you run `alias` twice). A counter that moved on a repeat
  could not be corrected afterwards — the duplicate is in the log forever,
  so `rebuild` would reproduce the wrong answer.
- **Values are sanitised.** Control bytes, ANSI escape sequences, newlines
  and bidi overrides are stripped or folded to spaces on the way in and on
  the way out. Names are printed to a terminal unescaped by `names`,
  `find` and `search`, and `custom-title` is a free-text field somebody
  types into.
- **`display_name_channel` explains `display_name`.** `alias` outranks a
  Claude Code rename, so it is possible to rename a session in Claude
  Code and see no change. Surface the channel and the UI can say
  "showing the alias" instead of looking broken.

The precedence chain is defined once, in `lib/names.mjs`, and exported as
`resolveDisplayName`. It takes a `{ channel: value }` map rather than a
session record on purpose: this database is authoritative for name
**history**, but the Claude Code transcript is authoritative for the
**current** value of its own channels (the copy here only refreshes on
`SessionStart`). A consumer holding a fresher observation overrides that
one channel and still gets the shared rule:

```js
import { resolveDisplayName, nameValuesFromSession } from '@druumen/sessions-db';

resolveDisplayName({
  ...nameValuesFromSession(session),
  cc_custom_title: freshlyReadFromTranscript,   // yours wins, rule is still ours
});
```

`session.alias` and `session.ai_title` remain as derived views of the
`alias` / `cc_ai_title` channels, so existing consumers are unaffected.

### Upgrading to 0.3.0: the projection repairs itself once

`names[].set_count` and `names[].observed_from` are folds of the event
log, so a projection cache written by an older build carries values the
log disagrees with — and nothing in normal operation would ever correct
them, because the derived-name refresh only touches sessions that receive
a new event.

`_meta.names_model_version` closes that: the first `loadProjection` on a
cache without the stamp recomputes every name block the log can speak for,
leaves any session the log cannot speak for exactly as it was, and stamps
the result. One fold, once per database (18 ms over a 2018-event log), and
every later load takes the fast path. No manual `rebuild` needed; running
one is harmless.

`schema_version` deliberately stays `2` — the record shape did not change
and the typed contract pins it — which is why this needed its own marker.

### Version skew: an old reader IGNORES `name_set`

A pre-0.3.0 reducer treats `name_set` as an unknown op — a no-op that
still counts toward `event_count`. It is not destructive (nothing is
deleted, and `events.jsonl` keeps every row), but while that reader is in
charge the projection will not reflect names written by a newer one:
`sessions-db names` on a channel other than `alias` writes `name_set`, and
a 0.2.0 `rebuild` will not see it.

`alias` is the exception, on purpose. It keeps writing the legacy
`alias_set` op even though `name_set` is the general form, because the
reducer feeds `alias_set` into the channel model anyway — so the new model
loses nothing — while an older reader can still fold it. That matters more
here than anywhere else: `loadProjection` rebuilds from the log whenever
the cache is missing or corrupt, so an older binary on the same machine
drops names *without anybody asking it to rebuild*, and `alias` is the one
channel a human sets by hand.

The rule is still the same as below — pin one version per machine rather
than mixing.

### Version skew: an old reader RESURRECTS pruned records

An older reader folding a 0.2.0 log tolerates `session_progress` as an
unknown op (no-op, still counted toward `event_count`). `session_prune`
is different, and calling it a no-op would be wrong: the reducer creates
the session record for *any* op before dispatching on it, and only
0.2.0+ knows to delete it again. Folding a pruned log with a pre-0.2.0
reducer therefore brings every tombstoned record back — with
`last_progress_at` set to the tombstone's timestamp, i.e. looking *more*
recently active than it ever was.

That is harmless for a read-only reader, but `rebuild` **saves**:

```bash
npx @druumen/sessions-db@0.1.7 rebuild   # silently un-prunes every record
```

There is no version guard to catch this — `schema_version` is written
but nothing gates on it, and it stays `2` either way. So:

- **Do not run an older version's `rebuild`** against a database that has
  been pruned. Pin one version per machine (`npx -y @druumen/sessions-db@0.2.0`,
  or a local install) rather than mixing.
- If it happens, it is recoverable: re-run `sessions-db prune --yes` with
  a current version. The tombstones are still in `events.jsonl` — the
  original observations are never rewritten — but a fresh prune is what
  reconciles the projection, and the resurrected records will have to
  clear the criteria again.
- `schema_version` was deliberately **not** bumped for this: nothing in
  any shipped reader compares it, so a bump would break the typed
  `schema_version: 2` contract and the documented 0.5.0 migration plan
  while changing no behaviour. Documenting the skew is the honest fix.

The pending area (`sessions-db-pending/`) is deliberately NOT part of the
schema: it is a staging buffer of throwaway files, safe to delete at any
time. Deleting a staged record loses only the precise session-start
timestamp of a session that has not been used yet; deleting the
`.promoter` marker just makes `SessionStart` record eagerly again until
the prompt hook next runs.

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

- **0.1.x**: Library + CLI + `SessionStart` hook + 3-priority identity +
  cross-platform (macOS / Linux verified in CI; Windows pending runner) +
  privacy opt-out (`storeFirstPrompt: false` /
  `DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0`) + free-text `search`.
- **0.2.0**: `UserPromptSubmit` hook (real first-prompt preview,
  live progress timestamps, branch drift), deferral of never-used sessions
  so ghosts are not created, and `prune` to clear historical ones.
- **0.3.0** (current): the session **name model** — every naming channel
  recorded with its authorship and history, `sessions-db names <id>`,
  name-aware `search` (`--include-history`), and one shared precedence
  chain for every consumer.
- **0.4.0** (TBD): parent_candidate auto-promote heuristic, outcome
  auto-derive on `/task-done` linkage.
- **0.5.0** (TBD): Multi-machine sync (schema_version=3 break,
  documented migration).
- **0.5.0+** (TBD): Web UI / VS Code Sessions panel via
  [Druumen Cockpit](https://druumen.com).
