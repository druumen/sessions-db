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
