# Changelog

All notable changes to `@druumen/sessions-db` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-08-19

Give a session all of its names, and give the names a history.

Four parties name a Claude Code session and only two of them reached the
database. The one carrying the strongest intent — `custom-title`, the name a
person types by hand in Claude Code — had no field and no collector: cockpit
read it off disk on every render and threw it away. And what *was* stored was
stored flat, so every rename overwrote the previous name with no way to read it
back. Measured on a 632-record reference database: 355 sessions carry a title,
**51 of them were renamed at least once** by the model as the conversation
drifted, and 406 rows recording those changes were sitting in `events.jsonl`
with nothing able to read them.

The failure that made it concrete: a session titled "Fix HTTP 400 error for
oversized goal parameter" was later renamed to "Analyze Knowledge Spine". As of
0.2.0, `search "Fix HTTP 400"` returned **nothing** — the current title was not
indexed (only `alias` and the first prompt were), and the former one had no read
path at all. The session existed, the data existed, and it was unfindable.

### Added

- **Name model (`lib/names.mjs`)** — one entry per **channel**, with
  **authorship** kept as a separate axis:

  | channel | who sets it | `source` | in the display chain |
  |---|---|---|---|
  | `alias` | `sessions-db alias` | `human` | yes — highest |
  | `cc_custom_title` | Claude Code hand-rename | `human` | yes |
  | `cc_ai_title` | Claude Code generated title | `llm` | yes |
  | `agent_name` | agent-team badge | `harvest` | **no** |
  | `first_prompt` | pseudo-channel for `first_prompt_preview` | — | yes — last |

  `source` is not a synonym for channel: `cc_ai_title` and `cc_custom_title`
  arrive through the same harvesting hook, but one was written by a model and
  the other typed by a person — and "show me only the names a human gave this
  session" is a question you cannot ask without that axis.

  `agent_name` is recorded but deliberately kept out of the display chain:
  measured, all 7 sessions carrying that record had it byte-identical to their
  `ai_title`. It is a badge, not a name.

- **`name_set` event op** — the general form. `alias_set` and `ai_title_seen`
  are still reduced, forever: the log is append-only, and those 406 existing
  rows (with their `observed_at` and `source_transcript`) are exactly where the
  name history starts. New writes emit only `name_set`.

- **`sessions-db names <id>` (`--json`)** — every name a session has had, per
  channel, with `set_at` / `source` / provenance, and each entry marked current
  or superseded. It **replays the event log** rather than reading the
  projection, because the projection deliberately does not have the answer.

- **`search --include-history`** — opt-in matching against names a session no
  longer has. Same cost shape as `--content`: the default path stays
  projection-only. Hits report the channel and whether the match was the
  current value or a former one (`name:<channel>` vs `name_history:<channel>`,
  plus a structured `name_hits` array in `--json`).

- **`setName()` library operation** — set or clear any channel. This is the
  write path a consumer needs to push back a name it observed itself; until
  something writes `cc_custom_title`, the database never learns the one name a
  human actually typed.

- **`extractLatestTitles()`** — one tail scan returns the most recent
  `ai-title`, `custom-title` and `agent-name` record. Measured on 353
  transcripts: the last `custom-title` is inside the 256 KiB tail window in 6
  of 6 files that have one, and `agent-name` in 7 of 7.

### Changed

- **`search` now indexes the current value of every naming channel.** The
  biggest single gap it closes is `ai_title` — the name you actually see in
  Claude Code, and previously the one thing metadata search did not cover (355
  of 632 records). Works on projections that predate this release, via the
  legacy fields.

- **`SessionStart` now harvests all three naming records**, one `name_set` per
  changed channel, with the same spam suppression as before (per channel).

- **`sessions-db alias` writes `name_set`** (channel `alias`, source `human`)
  instead of `alias_set`. Its stdout says `ok: name_set ...`; `session.alias` is
  unchanged.

- **`find`'s label column resolves through the shared chain.** It previously
  re-implemented a three-level version of it, missing `cc_custom_title` — so
  `find` and the cockpit panel could display different names for the same
  session, and the difference was precisely the sessions a user had renamed by
  hand. A hand-rename now renders with a `[custom]` tag.

- **`session.alias` / `session.ai_title` are now derived views** of the `alias`
  / `cc_ai_title` channels. They are still written and still correct; nothing
  that reads them needs to change. Removing them is a later migration, once
  every consumer reads `names[]`.

### Projection

Three optional fields per session — `names[]`, `display_name`,
`display_name_channel`. `schema_version` stays **2**: this release adds fields
and an op, and removes or repurposes nothing.

Two properties are load-bearing rather than incidental:

- **The projection stores current values only** — one entry per channel plus a
  `set_count`. History is unbounded by design and lives in `events.jsonl`;
  inlining it here would make the file that every cockpit refresh reads whole
  grow with every rename, turning a storage decision into a performance defect.
  Verified on the reference database: 51 renames, still one entry per channel.
- **A reader must preserve channels it does not recognise.** The channel set is
  open so that adding a namer is a non-event; the price is that filtering
  unknown channels would silently delete a newer version's names on the next
  save — no error, and nobody notices until a name they set is gone. Channel and
  source are bounded (1-64 / 1-32 chars of `[A-Za-z0-9._-]`, starting
  alphanumeric) so an open field cannot become an arbitrary payload lane, and a
  value is capped at 512 characters (the longest real title measured is 62).

`display_name_channel` is not decoration. `alias` outranks a Claude Code
rename — a deliberate choice, since it is the only channel a machine never
rewrites — so it is possible to rename a session in Claude Code and see no
change. The channel is what lets a UI say "showing the alias" rather than look
broken.

### Compatibility

- Rebuilding the full reference log (2017 events, 632 sessions) with this
  reducer produces records **identical field for field** to the previous one,
  with only the three new fields added.
- A pre-0.3.0 reducer treats `name_set` as an unknown op: not destructive, but
  its projection will not reflect names a newer version wrote. Pin one version
  per machine — see "Version skew" in the README.

## [0.2.0] — 2026-08-17

Stop the database from filling with sessions nobody ever used, and start
recording what actually happens inside the ones people do use.

Measured on a reference database of 623 records before this release: 189
sessions had `first_prompt_preview: null` permanently (of the 189 that resolved
as `minted` — opened once, never resumed — only 4 ever got a preview), 187 had
no transcript link at all, and 144 were records for processes that were never
spoken to. `SessionStart` was the only writer and it runs strictly *before* the
user says anything, so it was structurally incapable of knowing the first
prompt; nothing else ever wrote, so `last_progress_at` stayed frozen at
`created_at` and "sort by recent activity" actually sorted by "who got resumed".

### Added

- **`UserPromptSubmit` hook (`cli/sessions-db-user-prompt.mjs` + `-main.mjs`)** —
  the second writer. Fires on every prompt submission and:
  - latches `first_prompt_preview` from the hook payload's `prompt` field — no
    transcript read, no waiting for a flush;
  - advances `last_progress_at` on every turn;
  - refreshes `branch_current` / `head_last_seen` (the only fields that
    genuinely drift mid-session).

  Honours the same six-item safety contract as the SessionStart hook (cwd-gate,
  time budget, silent stderr, always exit 0, kill switch, shared git probe),
  with a **1000 ms** hard ceiling instead of 2000 ms because it sits on the
  user's per-turn latency path. Measured end-to-end p95: **136 ms** against the
  623-session / 1.35 MB reference projection (target was 200 ms).

- **`session_progress` EventOp** — the per-turn heartbeat.
  `first_prompt_preview` is first-write-wins (last-write-wins would leave every
  session titled "ok" or "continue"); `branch_current` / `head_last_seen` are
  last-write-wins.

- **`session_prune` EventOp + `sessions-db prune`** — removes ghost records.
  **Dry run by default**; `--yes` is required to write. A record is removed only
  when ALL of these hold: empty `first_prompt_preview`, both fingerprints null,
  empty `ai_title`, no transcript on disk for any of its `claude_session_ids`,
  `created_at` older than `--older-than` (default `1h`), and no operator intent
  attached (no alias / parent / child / task / project link, `outcome` still
  `open`). Append-only: a tombstone event is written and the reducer drops the
  record, so `rebuild` reproduces the pruned state and the original
  observations stay readable.

- **Pending area (`lib/pending.mjs`)** — `<storage-root>/sessions-db-pending/`,
  one small file per staged session, plus a `.promoter` liveness marker. See
  "Changed" below.

- **`gitContextFast` (lib/git-context.mjs)** — one-spawn git probe returning
  worktree root + HEAD + branch from a single
  `git rev-parse --show-toplevel HEAD --abbrev-ref HEAD`. Measured p50 5.9 ms /
  p95 6.3 ms versus p50 73 ms / p95 109 ms for the six-probe `gitContext`.
  Argument order is load-bearing (`--abbrev-ref` applies to every rev that
  follows it) and is pinned by a regression test.

- **`findTranscriptByCsid` / `indexTranscriptCsids` (lib/transcript.mjs)** —
  exact-identity transcript discovery across every workspace directory, and the
  bulk index `prune` uses.

- **`lib/hook-common.mjs`** — the cwd-gate, stdin parsing, id validation,
  privacy-opt-out predicate and storage-target resolver, lifted out of the
  SessionStart main so both hooks share one implementation. A disagreement
  between the two would mean one hook writing to a workspace the user never
  opted into, or promotion never finding its staged record.

### Changed

- **`SessionStart` no longer records unconditionally.** Claude Code 2.1.x keeps
  a daemon warm-pool (`claude bg-spare` / `bg-pty-host`) and the IDE panel
  spawns its own processes; each mints a session id and trips the hook, and
  most are never spoken to (11 of 13 records created on one measured day). The
  hook now writes an event only when it has positive evidence the session is
  real — either the transcript already contains a human prompt (resume /
  continue / compact), or the `claude_session_id` is already in the projection.
  Otherwise it stages a small record in the pending area and exits without
  touching the lock, the projection, or `events.jsonl`; the first
  `UserPromptSubmit` promotes it.

  A pending area was chosen over a `provisional: true` flag on the grounds of
  the lock, not the schema: `recordSessionSeen` holds the projection lock across
  load → resolveIdentity → append → apply → save (~33 ms p95 on the reference
  database) and it is the only writer that concurrent hooks contend for.
  Deferring removes that acquisition entirely for the ghost case, so warm-pool
  spawns stop competing with sessions that are working. A provisional flag would
  have kept every ghost inside the critical section and added a second lock
  cycle to clear the flag.

- **`created_at` is now earliest-wins** on `session_seen`. A promotion replays
  the deferred observation time so the record dates from process start rather
  than from the first prompt. Monotone-decreasing, so it stays
  order-independent and replay-stable.

- **`npm test` runs in two phases** — library/CLI suites in parallel, then the
  two hook integration suites with `--test-concurrency=1`. Those suites spawn
  real hook processes that carry real wall-clock ceilings (1 s / 2 s); when they
  competed with 140 other suites for 12 cores a hook would occasionally exceed
  its ceiling, exit 0 without writing (correct production behaviour), and fail
  the assertion that followed. Observed durations of 2.3–4.8 s for invocations
  that normally take ~300 ms. Total runtime is unchanged (~14 s) and the suite
  is now deterministic across repeated runs.

### Fixed

- **The transcript-location fallback no longer guesses.** Layer 3 of
  `locateTranscript` was "newest `.jsonl` in the workspace dir, by mtime". That
  was safe only by accident: the pre-0.1.7 `workspaceHashFromCwd` mis-encoded
  any path containing `_`, a space, `~`, or non-ASCII, so the directory was
  never found and the fallback returned nothing. Fixing the hash in 0.1.7 armed
  the guess — the directory now resolves, and on a real machine it holds 206
  transcripts belonging to other sessions. A wrong path lands in
  `transcript_files[]` and feeds `first_uuid` / `last_uuid` into the
  `transcript_lineage` matcher, which can merge two unrelated sessions into one
  stable_id. Layer 3 is now an exact `<claude_session_id>.jsonl` lookup across
  every workspace directory: it keeps the tolerance for hash/cwd drift and drops
  the recency guess. Both halves are pinned by tests, including a negative
  mutation run confirming the old heuristic fails them.

- **`prune` refuses to delete when the transcript scan proved nothing.**
  "No transcript on disk" is the ONLY criterion separating a real session
  nobody ever resumed from a ghost — a record written by 0.1.7's `SessionStart`
  has no preview, no fingerprint and no `ai_title` either. `indexTranscriptCsids`
  returns a well-formed empty result on any failure (by design, for its other
  callers) and nothing read its `errors` channel, so an empty scan silently
  satisfied that criterion for every record. Measured against a copy of the
  reference database (628 records): the real transcript root yielded 151
  candidates, an existing-but-empty directory yielded 192, and a non-existent
  directory also yielded 192 — the extra 41 in both cases were real sessions
  with real human questions. `sudo sessions-db prune --yes` (HOME becomes
  `/var/root`), a launchd/cron job, a container, a typo'd
  `DRUUMEN_CLAUDE_PROJECTS_ROOT` or a macOS TCC blip all produce exactly that
  scan. A real run now stops with an actionable message naming the root it
  scanned; a dry run still reports but marks the scan untrusted (`disk_scan.trusted`,
  and a warning above the candidate list). `--accept-untrusted-scan` is the
  escape hatch for a machine that genuinely has no transcripts. New export:
  `assessScanTrust`; `indexTranscriptCsids` now also returns the `root` it read.

- **A prompt for a session with no pending record and no projection entry is
  now recorded instead of dropped.** `lib/pending.mjs` states that losing a
  pending file "degrades to exactly the pre-existing behaviour (the session
  gets recorded on its first prompt, with `created_at` set to that moment)",
  and `PENDING_MAX_AGE_MS` justifies its 24 h GC on that basis. Neither was
  true: the prompt hook exited without writing when it found neither, and
  since the pending file stays gone, every later prompt of that session exited
  too — the session was never recorded anywhere. Two ordinary ways in: the
  staged file failing to write or being removed, and a session left open for
  more than 24 h before its first prompt ("open the tab Friday, type Monday").
  The old objection — "either an untracked workspace or a race with
  SessionStart" — does not hold: the cwd-gate has already run, and
  `recordSessionSeen` reconciles races under the projection lock by csid index.
  Such records carry `minted_from_prompt: true` in the event payload.

- **`SessionStart` checks whether staging actually succeeded.** `writePending`
  swallows its errors by contract (full disk, read-only FS, EPERM) and its
  return value was ignored, so a failed staging deferred a session with
  nothing on disk to promote. It now falls back to recording eagerly — the
  pre-0.2.0 behaviour, i.e. a ghost at worst.

- **The `.promoter` marker is now cross-examined once it goes stale.** The
  30-day window is right for "is the hook configured?", but it left a 30-day
  blind spot for the exact failure it exists to catch: removing the
  `UserPromptSubmit` registration while staying on 0.2.0 kept a "fresh" marker,
  so `SessionStart` deferred every session into a void for a month. A live
  promoter refreshes the marker hourly, so a marker untouched for 6 h with at
  least 3 sessions staged behind it (each ≥ 1 h old) is now treated as dead and
  the marker is retired — retired rather than ignored, because the evidence
  itself expires at `PENDING_MAX_AGE_MS` and the answer would otherwise
  oscillate. Self-healing: the next real prompt-hook run recreates it. Ghost
  stagings from before the marker went quiet do not count, so a healthy
  machine's warm-pool records cannot trip it.

- **The per-turn heartbeat no longer logs a preview of every prompt.**
  `session_progress` carried `first_prompt_preview` on every turn; the reducer
  discards all but the first (first-write-wins), so the only effect was
  persisting a 200-character excerpt of every prompt into the append-only log.
  Before 0.2.0 only the first prompt of a *resumed* session was ever stored, so
  this was an unannounced widening of what lands on disk. The preview is now
  sent only when the record does not have one yet — which still covers the case
  it exists for (a session that predates this hook).

- **`UserPromptSubmit` no longer anchors storage on an arbitrary cwd.**
  `gitContextFast` collapses every non-zero git exit into `not_a_repo` +
  `worktreePath: null`, and that includes `fatal: detected dubious ownership`
  on shared/mounted checkouts. The hook then fell back to `workspaceRoot = cwd`
  and created a second database wherever the user happened to be — reproduced
  as a stray `packages/deep/app/tickets/_logs/sessions-db-pending/.promoter`
  appearing in `git status`. Without a worktree root it now proceeds only when
  the target is already an established storage root (explicit
  `DRUUMEN_SESSIONS_DB_ROOT`, or a cwd that holds the database), and otherwise
  bails like `SessionStart` does.

- **`sanitizeFirstPrompt` no longer materialises the whole prompt** to produce
  200 characters. `Array.from(s)` allocated one array element per code point:
  a 32 MB single-line paste cost ~442 ms and ~328 MB of heap, and the hook that
  now calls it runs on every turn inside a 1 s ceiling, synchronously, on raw
  pasted input (measured 1994 ms end-to-end for that paste). It slices to
  `maxLen * 4` code units first. Output is byte-identical — pinned against the
  previous implementation across surrogate-pair boundaries — so
  `first_human_prompt_v1` fingerprints written before and after this change
  still match.

- **`findTranscriptByCsid` validates its id before joining it into a path.**
  It is exported from `lib/index.mjs` and interpolates the id into
  `<root>/<dir>/<id>.jsonl`; `findTranscriptByCsid('../../secret')` escaped the
  projects root. Not reachable through the hooks (they validate first), and its
  neighbour in `pending.mjs` already gated the identical input for the
  identical reason.

- **Documented that the hook time budgets bound async stalls only.** An unref'd
  timer cannot preempt a blocked event loop, so synchronous IO on a wedged
  mount (NFS / SMB / sshfs / FUSE) runs straight past the 1 s / 2 s ceilings —
  reproduced by making the cwd-gate's `CLAUDE.md` a FIFO with no writer, where
  the process ran to SIGKILL and the timer never fired. The docstrings said
  "hard timeout"; they now say what is actually guaranteed.

- **Documented the `session_prune` version-skew hazard** (README, "Version
  skew"). The claim that an older reader treats the new ops as no-ops is right
  for `session_progress` and wrong for `session_prune`: `applyEvent` creates
  the session record before dispatching on the op, so a pre-0.2.0 reducer
  resurrects every pruned record — dated to the tombstone's timestamp — and
  `npx @druumen/sessions-db@0.1.7 rebuild` persists that silently.
  `schema_version` stays `2` because no shipped reader compares it (a bump
  would change no behaviour while breaking the typed contract and the
  documented 0.4.0 migration); the hazard is documented and pinned by a test
  instead.

### Hook registration

`UserPromptSubmit` must be registered separately — installing 0.2.0 does not
wire it up. In `~/.claude/settings.json`, alongside the existing `SessionStart`
entry:

```jsonc
"UserPromptSubmit": [
  {
    "matcher": ".*",
    "hooks": [
      { "type": "command",
        "command": "node '<path-to>/@druumen/sessions-db/cli/sessions-db-user-prompt.mjs'" }
    ]
  }
]
```

**Upgrading without registering it is safe but pointless.** Deferral is gated on
promoter liveness: `SessionStart` defers only when it can see that the prompt
hook has actually run against this storage root (the `.promoter` marker, valid
30 days, and discredited earlier than that if sessions pile up unpromoted
behind a stale one — see "Fixed"). On a machine where only `SessionStart` is
registered, nothing ever writes that marker, so the hook keeps its pre-0.2.0
always-record behaviour — ghosts continue to accumulate, but no session is ever
lost. The failure mode this avoids is the dangerous one: deferring into a void
and silently recording nothing at all.

Consequence worth knowing: the first session in a given storage root after
installing is recorded eagerly, because no promoter has announced itself yet.
From the second session onward, deferral is active.

## [0.1.7] — 2026-06-04

Add a free-text `search` subcommand so AI tools (and humans) can locate the
past session that discussed/decided something, over Bash, at minimal context
cost (no MCP schema tax) — the inverse of `find`'s structured filtering.

### Added

- **`sessions-db search <query>` (cli/search.mjs)** — read-only, two tiers:
  - default: case-insensitive substring match across session **metadata**
    (alias / first prompt / branch / cwd / task / project / stable_id /
    claude_session_ids). Fast — projection only.
  - `--content` (alias `--deep`): ALSO scans **transcript message text**
    (`.jsonl`) and returns a snippet around the first hit. Slower (reads
    transcript files; `--max-file-mb` caps per-file size, default 32).
  - A session matches if EITHER tier hits; `matched_in` reports which, and
    `--json` (recommended for AI consumers) emits
    `{ stable_id, alias, first_prompt_preview, activity_state,
    last_progress_at, claude_session_ids, matched_in, snippet }`.
  - `--state` restricts to active/idle/archived; `--limit` (default 20).
- **`lib/search.mjs`** — pure helpers (`sessionMetadataFields`,
  `matchSessionMetadata`, `recordText`, `extractSnippet`), unit-tested.
- **`search --content` disk fallback** — when a session has no recorded
  `transcript_files`, content search now discovers its transcript on disk
  (cwd → `workspaceHashFromCwd` → `listTranscriptFiles`, filtered to files
  whose embedded sessionId matches the session's `claude_session_ids`), so
  sessions the hook never linked are still content-searchable. Disk-discovered
  hits are tagged `content(disk)` in `matched_in`. Per-invocation cached;
  best-effort (returns nothing on missing cwd/ids or absent workspace dir).

### Fixed

- **`workspaceHashFromCwd` (lib/transcript.mjs) — non-alphanumeric encoding.**
  It mapped only `/` and `.` to `-`, but Claude Code's `~/.claude/projects/`
  directory encoding replaces EVERY non-alphanumeric char (`_`, space, `~`,
  non-ASCII) with `-`, per character (consecutive separators not collapsed).
  Any workspace whose path contained `_`/space/`~`/non-ASCII therefore hashed
  to a directory name that never matched reality, silently breaking transcript
  location in the SessionStart hook (tiers 2+3) — the primary cause of empty
  `transcript_files`. Fixed to `replace(/[^a-zA-Z0-9]/g, '-')`; verified
  against live directories. This restores go-forward transcript linkage for
  underscore/space/non-ASCII workspaces (the common case) and is the
  precondition for the `--content` disk fallback above.

### Notes

- The hash fix recovers GO-FORWARD coverage (new sessions link correctly) and
  makes surviving transcripts discoverable; it does not resurrect transcripts
  that were rotated/deleted — most historically-empty `transcript_files` are
  genuine lost history, not an index gap. A backfill command (replay synthetic
  `session_seen` events into the projection) remains a possible follow-up for
  populating the canonical projection (which also feeds identity-lineage
  matching), distinct from the search-side fallback.

## [0.1.6] — 2026-05-24

Ingest Claude Code's AI-generated session title from transcript
`{"type":"ai-title", ...}` records so `sessions-db find` shows
meaningful labels even before the operator sets an alias.

### Added

- **`lib/transcript.mjs` — `extractLatestAiTitle(path, opts?)`**
  Tail-scans the last `AI_TITLE_TAIL_MAX_BYTES` (default 256 KiB) of a
  transcript jsonl and returns the most-recent
  `{"type":"ai-title", "aiTitle":"...", "sessionId":"..."}` record's
  `{ aiTitle, sessionId }`. Returns `null` when none found in the tail
  window — no full-file fallback (keeps the hook fast on multi-MB
  transcripts). Tolerates malformed JSON lines (including the truncated
  leading line that the tail window almost always starts mid-record)
  and records missing the `aiTitle` field. The constant
  `AI_TITLE_TAIL_MAX_BYTES` is exported so library consumers can tune
  the cap.

- **New projection field `ai_title: string|null`** on every
  `KnownSession`. Independent from `alias` — `alias` stays user-set
  semantics (operator opts into a deliberate label), `ai_title` is the
  AI-derived rolling label Claude Code shows in `/resume`. Existing
  sessions loaded from a pre-0.1.6 projection are defensively
  backfilled with `ai_title: null` on the next `session_seen` so
  consumers can read the field unconditionally.

- **New event op `ai_title_seen`** with payload
  `{ ai_title: string|null, source_transcript?: string, observed_at?: Iso8601 }`.
  Last-write-wins; `ai_title: null` clears the field. Reducer is
  idempotent under replay and rebuild.

- **Hook integration** — `cli/sessions-db-session-start-main.mjs` now,
  after `recordSessionSeen` lands the `session_seen` event, tail-scans
  the canonical transcript and appends an `ai_title_seen` event when
  the harvested title differs from the projection's current value.
  Duplicate-suppression is best-effort (read happens outside the lock);
  even on a race the reducer's last-write-wins semantics keep the final
  state consistent. Failures are silent per the hook exit-0 contract.

### Changed

- **`sessions-db find` table** — the column previously labeled `alias`
  is now `label` and follows display priority `alias` → `ai_title` →
  `first_prompt_preview` → `-`. Non-alias labels are tagged with an
  inline source marker so operators can tell what they're reading:
  - `[ai]` for ai_title-sourced labels
  - `[preview]` for first_prompt_preview-sourced labels
  - bare (no tag) for user-set alias
  `--json` output is unchanged: it still emits the raw `alias`,
  `ai_title`, `first_prompt_preview` fields independently so machine
  consumers can apply their own priority.

- **`cli/format.mjs`** exports a new pure helper `pickLabel(session)`
  returning `{ text, source }` so other tooling (tree-view, future
  TUI) can apply the same priority chain without re-implementing it.

### Backward compatibility

- `schema_version` stays at `2`. The `ai_title` field is additive; old
  events.jsonl files rebuild cleanly (new field defaults to null).
  Existing `0.1.x` cockpit consumers can read the new field through
  `KnownSession.ai_title` (TypeScript declarations updated) or ignore
  it entirely without any code change.
- No new npm dependencies.
- Hook hard-timeout (2 s) and exit-0 contract unchanged: ai_title
  harvest is wrapped in its own try/catch so any IO failure (missing
  transcript, locked projection, corrupted tail) silently degrades to
  "no ai_title update" rather than blocking Claude Code start.

### Tests

- New unit tests in `__tests__/unit/transcript.test.mjs` for
  `extractLatestAiTitle`: latest-by-position win, malformed-line
  tolerance, ai-title-without-aiTitle-field skip, tail-window cap
  enforcement (no full-file fallback), null returns for missing
  path / empty file / non-string input.
- New unit tests in `__tests__/unit/projection.test.mjs` for the
  `ai_title_seen` reducer: last-write-wins, explicit-null clear,
  defensive no-op on missing / empty / non-string payload, alias
  independence, rebuild determinism, legacy-record backfill.
- New unit tests in `__tests__/cli/format.test.mjs` for `pickLabel`
  and the source tag rendering.
- Existing format test updated for the renamed column header
  (`alias` → `label`).
- types-smoke updated for the new `ai_title` field on `KnownSession`
  and the new `ai_title_seen` EventOp.

## [0.1.5] — 2026-05-16

Hook now writes to the same storage location its reader is watching,
instead of always carving a fresh `tickets/_logs/` subdirectory into
whichever workspace it happens to fire in.

### Changed (hook)

- `cli/sessions-db-session-start-main.mjs` — storage location strategy
  is now three-tier (in order):

  1. **`DRUUMEN_SESSIONS_DB_ROOT` env var** — explicit override forwarded
     as `{ rootPath }`. Treated as the bare storage directory (no
     `tickets/_logs/` prefix added). Cockpit's Setup Wizard plumbs the
     workspace's chosen storage path through this env so a single source
     of truth controls both reader and writer location.

  2. **Auto-detect `<workspaceRoot>/.dru-code/sessions-db.json`** — when
     this file exists (i.e. cockpit Setup Wizard or a prior init created
     it), the hook writes alongside it via `{ rootPath: <ws>/.dru-code }`.
     Marketplace cockpit users no longer end up with a phantom
     `tickets/_logs/` subdirectory in their non-druumen project.

  3. **Legacy `{ root: workspaceRoot }`** — falls back to the
     pre-existing tickets/_logs/ layout anchored on the workspace root.
     Druumen monorepo (which has a `tickets/_logs/` already) keeps
     accumulating in the same place.

### Why

Before this fix, cockpit-marketplace users who clicked Setup Wizard's
Enable button got `<ws>/.dru-code/sessions-db.json` created by the
extension, but the SessionStart hook (running in a separate process)
ignored that location and wrote every event to a fresh
`<ws>/tickets/_logs/` subtree. Two consequences:

- **Visible split-brain**: cockpit's path-discovery priority chain
  picks `tickets/_logs/` once it exists (priority 3 > priority 4),
  but until the user did a window reload the orchestrator kept
  watching the wizard's empty `.dru-code/` stub. SESSIONS panel
  appeared frozen at `0 active` even though events were being written.

- **Workspace pollution**: an academic thesis or any non-druumen
  project ended up with a `tickets/_logs/` subdirectory it had no
  reason to own. With 0.1.5 the hook honors whichever convention was
  set up — cockpit-marketplace users stay clean inside `.dru-code/`.

### Test

- New `contract-1c` covers the env-override path: with
  `DRUUMEN_SESSIONS_DB_ROOT` set to a tmp dir outside the workspace,
  the hook writes there and creates no `tickets/_logs/` in the
  workspace.
- Existing `contract-1b` updated: when `.dru-code/sessions-db.json`
  pre-exists, the hook now writes to `.dru-code/` (NOT
  `tickets/_logs/` which the old version did).
- `happy path` and druumen-monorepo tests unchanged — workspaces with
  no `.dru-code/` marker still get the legacy `tickets/_logs/` layout.
- Full suite: 447 tests, 0 fail.

### Backward compatibility

- Druumen monorepo: zero change (no `.dru-code/` exists at any
  ancestor → step (3) legacy path).
- Cockpit-marketplace 0.3.0–0.3.2 users with `.dru-code/`: hook now
  writes to `.dru-code/`. Their old data (if any) in
  `<ws>/tickets/_logs/` is NOT migrated automatically; it stays as
  historical record. Future events go to `.dru-code/`. After upgrading
  cockpit to 0.3.3, the new wizard will additionally write a
  `DRUUMEN_SESSIONS_DB_ROOT` env prefix into the hook command so
  future enables explicitly pin the location.

## [0.1.4] — 2026-05-16

Hook gate relaxation so marketplace cockpit users on non-druumen
workspaces can actually record sessions.

### Changed (hook)

- `cli/sessions-db-session-start-main.mjs` — the cwd-gate accepts a
  workspace as authorized when EITHER:
  1. a `CLAUDE.md` containing the `Druumen Workspace` sentinel exists
     at cwd or any ancestor (original 0.1.x behavior), OR
  2. `.dru-code/sessions-db.json` or `tickets/_logs/sessions-db.json`
     exists at cwd or any ancestor — i.e. the workspace was already
     opted in via cockpit's Setup Wizard or a manual `initProjection`.
  Either marker counts as explicit user consent for this workspace.
  Workspaces with neither still bail silently — random scratch dirs
  still don't get session events.

### Why

Cockpit-vscode 0.3.0+ ships the Setup Wizard which creates
`<workspace>/.dru-code/sessions-db.json` on Enable. Before this fix,
the hook then rejected every SessionStart in that workspace because no
CLAUDE.md sentinel was present — events.jsonl stayed empty and the
SESSIONS panel showed `0 active` forever. The `.dru-code/` file
already represents user consent; the gate now treats it as such.

### Test

- New `contract-1b` test in
  `__tests__/hook/sessions-db-session-start.test.mjs` plants a
  `.dru-code/sessions-db.json` in a workspace with NO CLAUDE.md
  sentinel and verifies the hook records a session_seen event.
  Existing `contract-1` still passes (workspace with neither marker
  still rejects).
- Full suite: 446 tests, 0 fail.

### No public API change

Same exported surface as 0.1.3. The gate widening is additive;
consumers that previously passed still pass. Cockpit pin
`>=0.1.0 <0.2.0` picks up 0.1.4 automatically on `npm install`.

## [0.1.3] — 2026-05-15

CI metadata patch. **Same source code as 0.1.1 / 0.1.2** — both prior
versions stayed tombstone tags because separate npm-side gates
rejected the publish. This release fixes the second one. Cockpit pin
`>=0.1.0 <0.2.0` will pick up 0.1.3.

### Fixed (CI / supply chain)

- `package.json` `repository.url` switched from
  `git+ssh://git@gitlab.tinfant.org:8922/druumen/sessions-db.git` to
  `git+https://github.com/druumen/sessions-db.git`. Required by npm
  registry's provenance verification: when a package is published with
  `--provenance` from GitHub Actions, npm rejects (HTTP 422) if the
  signed provenance source URL doesn't match `repository.url` in the
  shipped tarball's package.json. Defense against supply-chain attacks
  where attestation comes from a different repo than the metadata
  claims.

### Repo SSoT vs publish-canonical mirror

- **Source-of-truth (development)**: `gitlab.tinfant.org/druumen/sessions-db`
  (private to tinfant org, where MRs land + CI runs first).
- **Publish-canonical (npm-visible)**: `github.com/druumen/sessions-db`
  (public mirror, what `npm publish --provenance` attests to + what
  `npm view @druumen/sessions-db | grep repository` shows consumers).

This split is now documented in `README.md` and `RELEASING.md`. Issues
+ MRs continue to live on GitLab; the GitHub mirror is for `npm
install` consumers' "view source" link + provenance attestation.

### Tombstone tag note (0.1.2)

- `v0.1.2` exists on GitLab + GitHub mirror as a permanent tag against
  commit `d908df77` but is **NOT published to npm**. The OIDC publish
  attempt got past the auth fix from 0.1.2's CI change (npm 11.5.x),
  signed provenance to Sigstore log `1549510274` (immutable), but
  failed at the registry PUT with `422 Unprocessable Entity` because
  of the repo URL mismatch fixed in 0.1.3.
- Together with `v0.1.1` (logIndex 1547090299 / 1549427812), there are
  now **3 sigstore provenance records** on the public transparency log
  for failed-publish attempts of this package's 0.1.x series. They
  prove the GitHub Actions runner attempted publishes and serve as
  audit trail.

### `[ASSUMPTION]` lessons recorded (per `feedback_tag_vendor_assumptions_in_plans`)

Day-of-OIDC-bringup assumption miss #2 (after the npm-version one):
- "Provenance verification accepts any repository.url in package.json"
  → wrong. npm rejects 422 if signed provenance source doesn't match
  metadata. This is npm's documented behavior but wasn't surfaced in
  the original D15 design or RELEASING.md.

Will save a second feedback memory specifically for "OIDC publish
requires repo-URL alignment with provenance signer" so future plans
flag it.

## [0.1.2] — 2026-05-15

CI-only patch. **Same source code as 0.1.1** — but 0.1.1 never actually
landed on the npm registry; it stayed a tombstone tag because the
GitHub Actions OIDC publish workflow used npm 10.8.2 (default for
Node 20), which signs sigstore provenance fine but lacks the OIDC
trusted-publisher token-exchange flow that npm registry requires
(added in npm **11.5.1**). The publish PUT got 404 (npm-style auth
masking) twice in a row.

This release fixes the workflow + ships the same library code under
0.1.2. Cockpit pinning `>=0.1.0 <0.2.0` will pick this up
automatically; no manual install change needed.

### Fixed (CI / supply chain)

- `.github/workflows/publish.yml` now runs `npm install -g npm@latest`
  before the publish step. Picks up OIDC trusted publisher support
  (≥11.5.1) without changing the runner's Node version (constrained
  by `engines: ">=18.0.0"` in package.json).

### Tombstone tag note (0.1.1)

- `v0.1.1` exists on GitLab + GitHub mirror as a permanent tag against
  commit `4350814e` but is **NOT published to npm**. Two failed OIDC
  publish attempts left two sigstore provenance records on the public
  transparency log (`logIndex 1547090299` and `logIndex 1549427812`),
  immutable forever — they prove the GitHub Actions runner attempted
  to publish that tag. Consumers should ignore `v0.1.1` entirely.
- The 0.1.1 CHANGELOG entry is preserved below as the full record of
  the packaging fixes that **shipped under 0.1.2**.

### `[ASSUMPTION]` lesson recorded

- Per memory `feedback_tag_vendor_assumptions_in_plans` (saved
  2026-05-15): the assumption "npm CLI shipped with Node 20 supports
  OIDC trusted publisher" was written as fact in the original D15
  publish.yml. Both Codex round-2 review and the cockpit owner's
  bootstrap step 7 missed it because both audited "trusted publisher
  is configured" without checking "is the runner's npm version
  capable of using it." Real-world v0.1.1 publish surfaced the gap.

## [0.1.1] — 2026-05-15

Packaging-only patch release. Fixes 3 independent bugs surfaced by the
first real consumer (Druumen Cockpit Phase 3 B1 integration) within
hours of 0.1.0 publish. **Zero runtime/library code changes** — same
public API surface, same test coverage. The fix is in how the package
is shipped, not what it does.

This is also the **first OIDC publish path test** — released via
GitHub Actions trusted publisher (no NPM_TOKEN_BOOTSTRAP), with
`--provenance` attestations. Consumers can now verify provenance via
`npm view @druumen/sessions-db@0.1.1 --json | jq .dist.attestations`.

### Fixed

- **Bug A — Node16 module resolution ignores top-level `types`** when
  `exports` map is present. 0.1.0 had bare-string-form
  `"exports": { ".": "./lib/index.mjs" }` plus a top-level
  `"types": "./types/index.d.ts"` — the top-level was silently
  dropped under cockpit's `moduleResolution: "Node16"`. Symptom:
  `TS7016: Could not find a declaration file for module '@druumen/sessions-db'`.
  Fix: conditional exports map with explicit `types` + `import` +
  `require` + `default` per entry. The top-level `types` is kept as
  legacy fallback for `moduleResolution: "node"` (older TypeScript).

- **Bug B — `types/index.d.ts` re-exported type aliases not values**.
  0.1.0 had a hand-crafted `types/index.d.ts` with patterns like
  `export type LoadProjection = typeof import('./storage.d.mts').loadProjection`
  — these are TYPE ALIASES, not VALUE re-exports. Consumer could write
  `import type { LoadProjection }` but not `import { loadProjection }`.
  Symptom: `TS2305: Module '@druumen/sessions-db' has no exported
  member 'loadProjection'`. Root cause: stale Day-2 artifact when
  `lib/index.mjs` was a stub; never updated when Day 3 added real
  value re-exports to `lib/index.mjs`. Fix: replace with a barrel
  pattern that stitches `./index.d.mts` (auto-emitted value re-exports
  mirroring lib/index.mjs) + `./types.d.mts` (auto-emitted type
  declarations from lib/types.mjs `@typedef` block).

- **Bug C — pure ESM rejected by Node16 CJS context**. 0.1.0 was pure
  ESM (`"type": "module"` + only `.mjs` source). Cockpit (Node16 +
  no `"type":"module"` → CJS context) hit `TS1479: ECMAScript module
  cannot be imported with require`. Fix: dual CJS+ESM build via
  esbuild — `lib/index.cjs` (62 KB bundle) is generated alongside
  `lib/index.mjs` by `npm run build:cjs`. Exports map's `require`
  condition routes CJS consumers to the bundle, `import` condition
  keeps ESM consumers on the per-file structure. The bundle is
  regenerated at `prepublishOnly` time so it always matches the
  current `lib/index.mjs` exports.

### Added

- **Regression guards** so Bug A / B / C class issues surface at
  publish time, not consumer integration time:
  - `__tests__/pack-install-smoke/pack-install-smoke.test.mjs` —
    end-to-end packaged-consumer smoke. `npm pack`s the source,
    installs the tarball into a temp consumer dir, then exercises
    the actual `package.json` exports map via 3 consumer styles:
    (a) CJS `require('@druumen/sessions-db')`, (b) ESM
    `import('@druumen/sessions-db')`, (c) TypeScript
    `moduleResolution: "Node16"` with both type and value imports.
    This is the canonical "consumer's POV" test — it would have
    caught all 3 of 0.1.0's Bug A / B / C at publish time. The other
    smokes complement it but bypass the exports map.
  - `__tests__/cjs-smoke/cjs-smoke.test.mjs` — runtime CJS smoke
    against `lib/index.cjs` directly. Asserts 35+ functions + 7+
    constants are callable.
  - `__tests__/types-smoke/cockpit-import.ts` — added VALUE imports
    block (was type-imports-only).
  - `__tests__/types-smoke/tsconfig.json` switched from
    `moduleResolution: "Bundler"` to `"Node16"`.
- **CI build-freshness gate** — both GitLab `test-linux` and GitHub
  Actions `Windows CI` now run `npm run build` followed by
  `git diff --exit-code lib/index.cjs types/`. If a contributor
  edits `lib/*.mjs` (changing exported signatures) but forgets to
  rerun the build before commit, CI fails fast at PR time instead
  of shipping a stale bundle to npm.

### Build

- **`esbuild` ^0.25.x** added as a devDependency (single dep, no
  runtime cost — bundle output has zero deps). `npm run build:cjs`
  produces `lib/index.cjs` from `lib/index.mjs`. `npm run build`
  runs both `build:types` (tsc) and `build:cjs` (esbuild).
  `prepublishOnly` runs `npm run build` so the tarball always
  contains the freshly-bundled CJS + freshly-emitted .d.mts.

- `package.json` `"main"` switched to `./lib/index.cjs` (CJS entry
  for legacy tooling). `"module"` field added pointing to
  `./lib/index.mjs` (legacy bundler hint, e.g. webpack 4).

### Tarball delta vs 0.1.0

- 50 → 51 files (+1: `lib/index.cjs`)
- 108.6 KB → 123.6 KB (+15 KB, all CJS bundle)
- 371.2 KB → 432.8 KB unpacked (still well under target)

### Codex round + lessons

- Codex adversarial review applied (agentId: see commit message of
  the round-2 fix commit).
- Per `feedback_tag_vendor_assumptions_in_plans` saved 2026-05-15:
  the assumption "ESM-only is fine for npm publishing" should have
  been tagged `[ASSUMPTION]` in the original D-path plan, not
  written as fact. Real-world consumer (cockpit Node16 CJS) surfaced
  the gap. Documented for future plan-drafting discipline.

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
  driven by JSDoc on the source `.mjs` files. Cockpit and other TS consumers
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
- **v0.1.0 published WITHOUT provenance attestations** — intentional.
  The bootstrap path runs from GitLab CI which has no GitHub-Actions-
  style OIDC token issuer for npm; the npm registry only accepts
  provenance from a recognized OIDC publisher (currently GitHub Actions
  and GitLab.com SaaS). `npm view @druumen/sessions-db@0.1.0 --json | jq
  .dist.attestations` returns `{}`. This is a one-time gap covering
  only the bootstrap release; v0.1.1 onwards have full provenance.
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

### Day 8 — 2026-05-15 (v0.1.0 published — 3 lessons learned)

- **Published**: `@druumen/sessions-db@0.1.0` live on npm registry at
  2026-05-15T08:22:56Z, Apache-2.0, `dist.shasum a70980a7…`. Pipeline
  #429 (post-release-prep merge `645a8a4e`): `test-linux` 9.4s +
  `mirror-to-github` 5.2s + `publish-npm` 12.6s. Trusted publisher
  configured on npm web (org=druumen, repo=sessions-db, workflow=
  publish.yml, env=npm-publish) immediately after bootstrap revoke,
  arming OIDC path for 0.1.1+.

- **Lesson 1 (Δ35 — protected `v*` tag gap)**: First v0.1.0 tag
  pipeline `mirror-to-github` failed because `GITHUB_MIRROR_TOKEN`
  (protected variable) wasn't accessible from `v*` tag pipelines —
  only `master` + `fix/*` were in the protected refs list. Fixed by
  adding `v*` to GitLab Protected Tags (Maintainers can create).
  RELEASING.md pre-flight now explicitly lists the protected-refs
  audit including `v*`.

- **Lesson 2 (Δ36 — npm Granular "Bypass 2FA" checkbox)**: 5
  consecutive `EOTP npm error code EOTP` failures during initial
  publish attempts. Root cause discovered: npm removed Classic
  Automation tokens in November 2025; only Granular Access Tokens
  are now supported, and Granular tokens require an OTP at publish
  time **even when the account is in `auth-only` 2FA mode**, unless
  the explicit "Bypass two-factor authentication (2FA)" checkbox is
  ticked at token creation. Token regenerated with the checkbox →
  immediate publish success. RELEASING.md Step 1 now flags this as
  a `MUST be checked` item with prominent ⚠️ marker.

- **Lesson 3 (Δ37 — v0.1.0 has no provenance)**: Documented in the
  Supply chain section above. Bootstrap path runs from GitLab CI
  which lacks GitHub-Actions-style npm OIDC integration; v0.1.0 ships
  without `dist.attestations`. Intentional and one-time — v0.1.1+ via
  OIDC restores full provenance.

- **Cockpit Phase 3 unblocked**: B1-B14 implementation begins
  immediately on cockpit side. `npm install @druumen/sessions-db`
  works for marketplace prep. Expect 1-2 minor patch releases
  (0.1.1 / 0.1.2) shaking out integration corner cases — these will
  be the first real exercise of the OIDC publish path.
