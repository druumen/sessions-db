/**
 * `sessions-db names <stable_id>` — every name a session has ever had, per
 * channel, with when it changed and who set it. Read-only.
 *
 * This is the read path that was missing. The data was already there: every
 * rename has been in `events.jsonl` since the first `ai_title_seen` was
 * written, and on the reference database that is 51 sessions that were
 * genuinely renamed by the model mid-conversation. Nothing could read it back,
 * so a session you remembered by an older name was, in practice, unfindable.
 *
 * ## Why this replays events instead of reading the projection
 *
 * Because the projection deliberately does not have the answer. It stores the
 * CURRENT value per channel and nothing else, so that its size stays O(number
 * of channels) instead of growing with every rename — it is the file every
 * cockpit refresh reads whole, and letting an unbounded log leak into it would
 * turn a storage decision into a performance defect.
 *
 * So the history comes from where history lives: the append-only log. The
 * current values shown here are folded from the same events rather than read
 * out of the cache, which makes this command a cross-check on the projection
 * as well as a reader of it — if they ever disagree, the cache is stale and
 * `rebuild` is the fix.
 *
 * Exit codes:
 *   0 — rendered
 *   1 — no such session in the event log (or it was pruned)
 *   2 — argparse error
 */

import {
  foldNameHistory,
  splitChannelHistory,
  sortChannels,
} from '../lib/names.mjs';
import { rebuildFromEvents } from '../lib/projection.mjs';
import { readAllEvents } from '../lib/storage.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = {
  positional: [{ name: 'stable_id', required: true }],
  flags: {
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db names <stable_id> [--json]',
  summary: 'Show every name a session has had, per channel, with change history.',
  flags: [
    { name: '--json',        desc: 'machine-readable JSON (recommended for AI tools)' },
    { name: '--root <path>', desc: 'override storage root (default cwd)' },
  ],
  examples: [
    'sessions-db names sess_019e94e4-4732-76d9-9b17-ff3c0ee74ff9',
    'sessions-db names sess_019e94e4-4732-76d9-9b17-ff3c0ee74ff9 --json',
  ],
});

/**
 * Pure core: fold one session's events into `{ session, channels, history }`.
 * Exported for tests — the CLI wrapper below only does IO and rendering.
 *
 * Returns `null` when the id has no events, or has a `session_prune`
 * tombstone as its last word (a pruned record must not still answer here, or
 * `names` would contradict `find`).
 *
 * @param {Array<object>} allEvents every event in the log
 * @param {string} stableId
 */
export function buildNamesView(allEvents, stableId) {
  const own = (Array.isArray(allEvents) ? allEvents : [])
    .filter((e) => e && e.stable_id === stableId);
  if (own.length === 0) return null;

  // Fold this session's own events only. `applyEvent` creates the record for
  // any op, so this yields the same record a full rebuild would produce for
  // this id — including `first_prompt_preview` and the derived display name,
  // which is why we can answer "what is it called and why" without the cache.
  const folded = rebuildFromEvents(own);
  const session = folded.sessions[stableId];
  if (!session) return null; // pruned

  const byChannel = foldNameHistory(own, { stableId }).get(stableId) ?? new Map();

  const channels = sortChannels([...byChannel.keys()]).map((channel) => {
    const entries = byChannel.get(channel);
    const { current, history } = splitChannelHistory(entries);
    return {
      channel,
      value: current ? current.value : null,
      set_at: current ? current.set_at : null,
      source: current ? current.source : null,
      observed_from: current ? current.observed_from : null,
      set_count: entries.length,
      history_count: history.length,
    };
  });

  // One flat timeline across channels, newest first — that is the order the
  // question "what was it called before?" wants to be answered in. Ties keep
  // event order (stable sort), so two names set in the same millisecond still
  // read in the order they were written.
  const history = [];
  for (const [channel, entries] of byChannel) {
    const lastIndex = entries.length - 1;
    entries.forEach((entry, i) => {
      history.push({
        channel,
        value: entry.value,
        set_at: entry.set_at,
        source: entry.source,
        observed_from: entry.observed_from,
        op: entry.op,
        event_id: entry.event_id,
        kind: i === lastIndex ? 'current' : 'history',
      });
    });
  }
  history.sort(compareBySetAtDesc);

  return { session, channels, history };
}

/**
 * Newest-first by `set_at`. Entries without a timestamp sort last rather than
 * first — an unknown time is not evidence of recency.
 */
function compareBySetAtDesc(a, b) {
  const sa = a.set_at || '';
  const sb = b.set_at || '';
  if (sa === sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  return sa < sb ? 1 : -1;
}

export async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (err) {
    if (err instanceof ArgparseError) {
      process.stderr.write(`error: ${err.message}\n\n${HELP}`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  if (parsed.helpRequested) {
    process.stdout.write(HELP);
    return;
  }

  const stableId = parsed.positional.stable_id;
  const root = parsed.flags['--root'];
  const { events } = readAllEvents(root ? { root } : {});
  const view = buildNamesView(events, stableId);

  if (!view) {
    process.stderr.write(`error: stable_id not found: ${stableId}\n`);
    process.exit(1);
  }

  if (parsed.flags['--quiet']) return;

  if (parsed.flags['--json']) {
    process.stdout.write(formatJSON({
      stable_id: stableId,
      display_name: view.session.display_name ?? null,
      display_name_channel: view.session.display_name_channel ?? null,
      first_prompt_preview: view.session.first_prompt_preview ?? null,
      channels: view.channels,
      history: view.history,
    }));
    return;
  }

  process.stdout.write(formatNames(stableId, view));
}

/**
 * Human rendering. Two blocks, because they answer two different questions:
 * "what is it called" (per channel, current) and "what was it called"
 * (timeline).
 */
export function formatNames(stableId, view) {
  const lines = [stableId];

  const displayName = view.session.display_name;
  if (displayName) {
    lines.push(`display: ${displayName}  [via ${view.session.display_name_channel}]`);
  } else {
    lines.push('display: (unnamed — no channel and no first prompt)');
  }
  lines.push('');

  if (view.channels.length === 0) {
    lines.push('No names have ever been set on this session.');
    return lines.join('\n') + '\n';
  }

  const rows = view.channels.map((c) => ({
    channel: c.channel,
    source: c.source || '-',
    set_at: c.set_at || '-',
    sets: String(c.set_count),
    // `null` here is a deliberate clear, which is NOT the same as never named
    // — the row exists precisely because somebody set a name and then removed
    // it, and flattening the two would erase that.
    value: c.value === null ? '(cleared)' : c.value,
  }));
  const head = { channel: 'channel', source: 'source', set_at: 'set_at', sets: 'sets', value: 'value' };
  const w = (key) => Math.max(head[key].length, ...rows.map((r) => r[key].length));
  const widths = {
    channel: w('channel'), source: w('source'), set_at: w('set_at'), sets: w('sets'),
  };
  const fmt = (r) => [
    r.channel.padEnd(widths.channel),
    r.source.padEnd(widths.source),
    r.set_at.padEnd(widths.set_at),
    r.sets.padStart(widths.sets),
    r.value,
  ].join('  ').trimEnd();

  lines.push(fmt(head));
  for (const r of rows) lines.push(fmt(r));

  const changed = view.history.filter((h) => h.kind === 'history');
  lines.push('');
  if (changed.length === 0) {
    lines.push('history: none — every channel still holds its first value.');
  } else {
    lines.push(`history (${changed.length} superseded, newest first):`);
    for (const h of view.history) {
      const mark = h.kind === 'current' ? '*' : ' ';
      const value = h.value === null ? '(cleared)' : h.value;
      lines.push(`  ${mark} ${h.set_at || '-'}  ${h.channel}  ${h.source}  ${value}`);
    }
    lines.push('  (* = current value of that channel)');
  }

  return lines.join('\n') + '\n';
}
