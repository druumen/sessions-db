/**
 * @druumen/sessions-db — public library entry.
 *
 * Curated re-export hub for the v0.1.0 public surface. Library consumers
 * (cockpit's primary integration target, plus any future tooling that talks
 * to sessions-db without spawning the CLI) should import EXCLUSIVELY from
 * `@druumen/sessions-db` (this file) — never from the deeper
 * `@druumen/sessions-db/lib/<module>.mjs` paths.
 *
 * The depth-paths still resolve (the package.json `exports` would let them),
 * but they're treated as unstable internals — no semver guarantee. This
 * file is the documented surface; anything not re-exported here is subject
 * to refactor without notice.
 *
 * Type-side mirror: `types/index.d.ts` (hand-crafted) re-exports the
 * matching TypeScript types so cockpit can write
 *
 *     import { setAlias, watchProjection, type Projection } from '@druumen/sessions-db';
 *
 * and resolve everything through one entry.
 */

// ---------------------------------------------------------------------------
// Storage primitives — for consumers that already have a fully-built event
// and want direct lock-and-apply control. Most consumers should use
// `operations.*` (validated, structured-result wrappers) instead.
// ---------------------------------------------------------------------------

export {
  loadProjection,
  rebuildProjection,
  recordSessionSeen,
  tryUpdateProjection,
  newEvent,
  appendEvent,
  readAllEvents,
  saveProjection,
  storageDir,
  lockPathFor,
  PATHS,
  MAX_EVENT_BYTES,
} from './storage.mjs';

// ---------------------------------------------------------------------------
// Operations — the primary write surface for library consumers. Each
// function: validates input, ensures the target session exists, writes
// the event under the projection lock, returns
// `{ ok, event_id?, error? }`.
// ---------------------------------------------------------------------------

export {
  setAlias,
  linkTask,
  unlinkTask,
  setParent,
  closeSession,
  runSweep,
} from './operations.mjs';

// ---------------------------------------------------------------------------
// Lifecycle — initialize storage and watch projection for changes.
// ---------------------------------------------------------------------------

export { initProjection } from './init.mjs';
export { watchProjection } from './watch.mjs';

// ---------------------------------------------------------------------------
// Path resolution — exposed so library consumers (cockpit Setup Wizard,
// debug tooling) can introspect which storage location the resolver picks
// before they commit to it. The same chain is used internally by every
// storage primitive; surface it for explicit callers.
// ---------------------------------------------------------------------------

export {
  resolveStoragePaths,
  pathsFromRoot,
  STORAGE_FILENAMES,
  MAX_ASCEND_DEPTH,
} from './paths.mjs';

// ---------------------------------------------------------------------------
// Identity — pure helpers for resolving stable_id from a Claude session
// signal set. Useful for consumers that want to introspect the resolution
// chain (e.g. visualize "matched by lineage" in a UI) without minting.
// ---------------------------------------------------------------------------

export {
  resolveIdentity,
  findByClaudeSessionId,
  findByTranscriptLineage,
  scanFingerprintCandidates,
  collectParentCandidates,
  capParentCandidates,
  classifyCorroborators,
  meetsThreshold,
  MAX_PARENT_CANDIDATES,
  STRONG_CORROBORATORS,
  WEAK_CORROBORATORS,
} from './identity.mjs';

// ---------------------------------------------------------------------------
// Sweep — pure planner. `runSweep` (above) wraps these for actual writes,
// but consumers may want the planner alone (e.g. preview UI in cockpit).
// ---------------------------------------------------------------------------

export {
  computeSweepTransitions,
  computeEffectiveLastProgress,
} from './sweep.mjs';

// ---------------------------------------------------------------------------
// Prune — ghost-record removal. `computePruneCandidates` is pure (feed it a
// projection + a Set of on-disk claude_session_ids) so cockpit can render a
// "these would be removed" preview without touching disk itself; `runPrune`
// does the scan + tombstone transaction. `assessScanTrust` is exported for the
// same reason cockpit needs it: a UI that renders a candidate list from an
// empty transcript scan is showing real sessions, not ghosts.
// ---------------------------------------------------------------------------

export {
  runPrune,
  computePruneCandidates,
  hasTranscriptOnDisk,
  assessScanTrust,
  parseDuration,
  DEFAULT_OLDER_THAN_MS,
} from './prune.mjs';

// ---------------------------------------------------------------------------
// Pending area — the staging buffer that keeps never-used sessions out of the
// database entirely. Surfaced so cockpit can show "N sessions open but not yet
// used" and so ops tooling can GC the area explicitly.
// ---------------------------------------------------------------------------

export {
  pendingDir,
  pendingPath,
  writePending,
  readPending,
  deletePending,
  listPending,
  sweepPending,
  markPromoterAlive,
  isPromoterAlive,
  PENDING_DIRNAME,
  PENDING_MAX_AGE_MS,
  PROMOTER_MARKER,
  PROMOTER_MAX_AGE_MS,
  PROMOTER_STALE_AFTER_MS,
  PROMOTER_BACKLOG_MIN_COUNT,
  PROMOTER_BACKLOG_MIN_AGE_MS,
} from './pending.mjs';

// ---------------------------------------------------------------------------
// Transcript discovery — exact-identity lookups over ~/.claude/projects.
// `findTranscriptByCsid` is the safe replacement for the old "newest jsonl in
// the workspace dir" guess; `indexTranscriptCsids` is the bulk form used by
// prune.
// ---------------------------------------------------------------------------

export {
  workspaceHashFromCwd,
  listTranscriptFiles,
  findTranscriptByCsid,
  indexTranscriptCsids,
} from './transcript.mjs';

// ---------------------------------------------------------------------------
// Sanitize — pure prompt-cleanup helpers used by the hook to redact PII /
// IDE wrappers / system reminders before persistence. Re-exported so any
// consumer constructing payloads outside the hook can apply the same
// guarantees.
// ---------------------------------------------------------------------------

export {
  sanitizeFirstPrompt,
  stripIdeWrappers,
  stripSystemReminders,
} from './sanitize.mjs';

// ---------------------------------------------------------------------------
// UUIDv7 — session_id minter + helpers. Cockpit currently relies on
// `generateSessionId` to mint synthetic ids in tests; expose for parity
// with the internal hook.
// ---------------------------------------------------------------------------

export {
  generateSessionId,
  isSessionId,
  extractTimestamp,
} from './uuid.mjs';

// ---------------------------------------------------------------------------
// Projection reducers — pure folders. Surface them so library consumers
// (and tests) can build projections from event arrays without importing
// the deep path.
// ---------------------------------------------------------------------------

export {
  applyEvent,
  emptyProjection,
  emptySession,
  rebuildFromEvents,
} from './projection.mjs';
