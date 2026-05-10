/**
 * Cockpit-style import smoke test for `@druumen/sessions-db` types.
 *
 * Verifies that the curated `types/index.d.ts` resolves all the public
 * type names cockpit (and other TS consumers) need to author their own
 * code against this package, without runtime knowledge of which `lib/*`
 * file each typedef physically lives in.
 *
 * Execution model:
 *   - This file is `.ts` and is NEVER emitted to JS (test runner is the
 *     TypeScript compiler with `--noEmit`).
 *   - `npm run check:types-smoke` invokes `tsc --noEmit -p
 *     packages/sessions-db/__tests__/types-smoke/tsconfig.json`.
 *   - tsc resolves `@druumen/sessions-db` via the smoke tsconfig's
 *     `paths` mapping (because we're not actually published to npm).
 *
 * Failure mode:
 *   - If any of the imported names go missing, `tsc` errors with
 *     `TS2305: Module '"@druumen/sessions-db"' has no exported member 'X'`.
 *   - If a structural shape changes incompatibly (e.g. `KnownSession`
 *     loses a field cockpit relies on), the assertion expressions below
 *     fail to compile.
 *
 * What this test does NOT cover (deliberately):
 *   - Runtime behavior — that's covered by the 355-test Node test runner
 *     suite. This file imports type-only.
 *   - Day 3 function re-exports through `lib/index.mjs`. Today the
 *     runtime entry is a stub; types are the only thing flowing through
 *     `index.d.ts`. Day 3 will add a runtime smoke that imports the
 *     functions themselves.
 */

import type {
  // Branded scalars
  SessionStableId,
  ClaudeSessionId,
  EventId,
  Iso8601,
  // Enums
  ActivityState,
  Outcome,
  IdentitySource,
  IdentityConfidence,
  EventOp,
  // Composite shapes
  TranscriptFile,
  IdentityResolution,
  ParentCandidate,
  KnownSession,
  ProjectionMeta,
  Projection,
  SessionEvent,
} from '@druumen/sessions-db';

// ---------------------------------------------------------------------------
// Branded-scalar smoke: assignments compile because each is a string alias.
// ---------------------------------------------------------------------------

const _stableId: SessionStableId = 'sess_018f1234-5678-7abc-89de-0123456789ab';
const _csid: ClaudeSessionId = '550e8400-e29b-41d4-a716-446655440000';
const _eventId: EventId = 'evt_018f1234-5678-7abc-89de-0123456789ac';
const _ts: Iso8601 = '2026-05-10T20:50:00.000Z';

// ---------------------------------------------------------------------------
// Enum smoke: literals compile against the union; misspellings would fail
// at type-check time (e.g. `'activ'` would be TS2322).
// ---------------------------------------------------------------------------

const _activityActive: ActivityState = 'active';
const _activityIdle: ActivityState = 'idle';
const _activityArchived: ActivityState = 'archived';

const _outcomes: Outcome[] = [
  'open',
  'done',
  'blocked',
  'abandoned',
  'merged',
  'superseded',
];

const _identitySources: IdentitySource[] = [
  'claude_session_id_index',
  'transcript_lineage',
  'fingerprint_corroborator',
  'minted',
];

const _identityConfidences: IdentityConfidence[] = [
  'exact',
  'high',
  'low',
  'minted',
];

const _eventOps: EventOp[] = [
  'session_seen',
  'session_link',
  'session_unlink',
  'alias_set',
  'parent_set',
  'close',
  'sweep',
  'manual_link',
];

// ---------------------------------------------------------------------------
// Composite shape smoke: build literal values that match the typedefs.
// If a required field is missing or a type is wrong, tsc surfaces
// TS2322 / TS2741 at compile time.
// ---------------------------------------------------------------------------

const _transcriptFile: TranscriptFile = {
  path: '/Users/x/.claude/projects/-Users-x/abc.jsonl',
  first_uuid: '550e8400-e29b-41d4-a716-446655440000',
  last_uuid: '550e8400-e29b-41d4-a716-446655440099',
  size: 1234,
  mtime: '2026-05-10T20:50:00.000Z',
  status: 'ok',
};

const _identityResolution: IdentityResolution = {
  source: 'claude_session_id_index',
  confidence: 'exact',
  matched: { claude_session_id: '550e8400-e29b-41d4-a716-446655440000' },
};

const _parentCandidate: ParentCandidate = {
  candidate: 'sess_018f1234-5678-7abc-89de-0123456789ab',
  confidence: 'low',
  reason: {
    fingerprints_matched: ['first_human_prompt_v1'],
    corroborator_count: 2,
    strong_corroborator_count: 1,
    weak_corroborator_count: 1,
  },
};

const _knownSession: KnownSession = {
  stable_id: 'sess_018f1234-5678-7abc-89de-0123456789ab',
  alias: null,
  claude_session_ids: ['550e8400-e29b-41d4-a716-446655440000'],
  transcript_files: [_transcriptFile],
  fingerprints: {
    first_human_prompt_v1: null,
    lineage_prefix_v1: null,
  },
  parent_session_id: null,
  parent_candidate_ids: [],
  parent_candidates_omitted_count: 0,
  identity_resolution: _identityResolution,
  worktree_path_observed: null,
  worktree_realpath: null,
  worktree_registry_name: null,
  git_common_dir: null,
  branch_at_start: null,
  branch_current: null,
  head_at_start: null,
  head_last_seen: null,
  tasks: [],
  projects: [],
  activity_state: 'active',
  outcome: 'open',
  closed_at: null,
  closed_reason: null,
  created_at: '2026-05-10T20:50:00.000Z',
  last_progress_at: '2026-05-10T20:50:00.000Z',
  first_prompt_preview: null,
};

const _projectionMeta: ProjectionMeta = {
  schema_version: 2,
  fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
  updated: '2026-05-10T20:50:00.000Z',
  event_count: 1,
  last_event_id: 'evt_018f1234-5678-7abc-89de-0123456789ac',
};

const _projection: Projection = {
  _meta: _projectionMeta,
  sessions: {
    'sess_018f1234-5678-7abc-89de-0123456789ab': _knownSession,
  },
};

const _event: SessionEvent = {
  ts: '2026-05-10T20:50:00.000Z',
  event_id: 'evt_018f1234-5678-7abc-89de-0123456789ac',
  op: 'session_seen',
  stable_id: 'sess_018f1234-5678-7abc-89de-0123456789ab',
  payload: { claude_session_id: '550e8400-e29b-41d4-a716-446655440000' },
};

// ---------------------------------------------------------------------------
// Index-by-stable-id smoke: prove that `Projection.sessions` is keyed by
// `SessionStableId` and that the value is a full `KnownSession`.
// ---------------------------------------------------------------------------

const _lookup = _projection.sessions[_stableId];
// `_lookup` is `KnownSession | undefined` — accessing a known field
// requires a narrow first; we just verify the type keys line up.
if (_lookup) {
  const _activity: ActivityState = _lookup.activity_state;
  void _activity;
}

// Suppress unused-var warnings — the file's purpose is type resolution,
// not value flow.
void _csid;
void _eventId;
void _ts;
void _activityIdle;
void _activityArchived;
void _outcomes;
void _identitySources;
void _identityConfidences;
void _eventOps;
void _parentCandidate;
void _event;
