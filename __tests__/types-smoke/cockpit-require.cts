/**
 * CJS-context type smoke for `@druumen/sessions-db`.
 *
 * The sibling `cockpit-import.ts` compiles the `import` condition of the
 * package exports map, which resolves `types/index.d.ts`. Nothing compiled
 * the `require` condition, which resolves a SEPARATE, hand-maintained file:
 * `types/index.d.cts`. That file's own header claims it is "identical to
 * index.d.ts except for the extension", and by 0.3.0 it was not — the five
 * name-model type names had been added to one and not the other, so a CJS
 * consumer (cockpit is named in that header as the reason the file exists)
 * could not import a single one of them. Nothing could notice, because no
 * check ever read the file.
 *
 * This fixture is that check. The `.cts` extension is what makes it a CJS
 * module to TypeScript regardless of the package's `"type": "module"`, which
 * is what routes resolution through the `require` condition's types.
 *
 * Type-only plus one value import: the value side is the 0.1.0 Bug B
 * regression guard (type-only re-exports compiled fine and broke every real
 * consumer), and it costs one line to keep here.
 */

import type {
  // Branded scalars
  SessionStableId,
  Iso8601,
  // Enums
  ActivityState,
  EventOp,
  // Names (0.3.0) — the block that was missing from this file entirely
  NameChannel,
  NameSource,
  SessionName,
  NameHistoryEntry,
  ResolvedDisplayName,
  // Composite shapes
  KnownSession,
  ProjectionMeta,
  Projection,
  SessionEvent,
} from '@druumen/sessions-db';

import { loadProjection, resolveDisplayName, setAlias } from '@druumen/sessions-db';

void loadProjection;
void resolveDisplayName;
void setAlias;

const _channel: NameChannel = 'cc_custom_title';
const _source: NameSource = 'human';

const _name: SessionName = {
  channel: _channel,
  value: 'redesign BM overview',
  set_at: '2026-08-19T10:00:00.000Z',
  source: _source,
  set_count: 1,
};

const _historyEntry: NameHistoryEntry = {
  channel: _channel,
  value: 'an older name',
  set_at: '2026-08-01T10:00:00.000Z',
  source: _source,
  observed_from: null,
  op: 'name_set',
  event_id: 'evt_018f1234-5678-7abc-89de-0123456789ac',
};

const _resolved: ResolvedDisplayName = {
  display_name: 'redesign BM overview',
  display_name_channel: _channel,
};

const _stableId: SessionStableId = 'sess_018f1234-5678-7abc-89de-0123456789ab';
const _ts: Iso8601 = '2026-08-19T10:00:00.000Z';
const _activity: ActivityState = 'active';
const _op: EventOp = 'name_set';

const _projectionMeta: ProjectionMeta = {
  schema_version: 2,
  fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
  updated: _ts,
  event_count: 1,
  last_event_id: 'evt_018f1234-5678-7abc-89de-0123456789ac',
};

// `names` / `display_name` are optional on KnownSession: a projection written
// before 0.3.0 does not carry them, and a consumer must be able to describe
// that record too.
const _session: Partial<KnownSession> & { stable_id: SessionStableId } = {
  stable_id: _stableId,
  names: [_name],
  display_name: _resolved.display_name,
  display_name_channel: _resolved.display_name_channel,
  activity_state: _activity,
};

const _projection: Partial<Projection> = { _meta: _projectionMeta };

const _event: SessionEvent = {
  ts: _ts,
  event_id: 'evt_018f1234-5678-7abc-89de-0123456789ac',
  op: _op,
  stable_id: _stableId,
  payload: { channel: _channel, value: 'redesign BM overview', source: _source },
};

void _historyEntry;
void _session;
void _projection;
void _event;
