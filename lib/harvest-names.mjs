/**
 * Shared name harvesting — the naming records Claude Code writes into a
 * session's transcript (`ai-title`, `custom-title`, `agent-name`), turned into
 * `name_set` events.
 *
 * ## Why this lives in lib/ instead of inside the SessionStart hook
 *
 * It used to be private to `cli/sessions-db-session-start-main.mjs`, which
 * made the collection time equal to session start. That is the one moment a
 * fresh session has NOTHING to harvest: Claude Code generates the title after
 * the first exchange, so at SessionStart the transcript is empty (or, for a
 * brand-new session, does not exist yet). The consequence was not "some
 * titles are missed" but "a session that is never resumed never gets a name
 * at all" — measured on the reference machine at 289 of 688 records (42%)
 * with no harvested name, while their transcripts on disk carried one.
 *
 * Both hooks now call this. `UserPromptSubmit` fires on every turn, so from
 * the second prompt onward the current title is in the database without the
 * session ever being resumed.
 *
 * The function is deliberately whole-fat rather than split per channel: the
 * suppression logic below has to agree with the reducer about what counts as
 * a change, and that agreement is easier to keep in one place than in three.
 */

import { existsSync } from 'node:fs';

import { extractLatestTitles, isMachineGeneratedCustomTitle } from './transcript.mjs';
import {
  CHANNEL_AGENT_NAME,
  CHANNEL_CC_AI_TITLE,
  CHANNEL_CC_CUSTOM_TITLE,
  SOURCE_HARVEST,
  SOURCE_HUMAN,
  SOURCE_LLM,
  currentNameValue,
  findNameEntry,
  isValidNameValue,
  nameSetPayload,
} from './names.mjs';
import { sanitizeNameValue } from './sanitize.mjs';
import { loadProjection, newEvent, tryUpdateProjection } from './storage.mjs';

/**
 * Tail-scan `transcriptPath` for the most-recent record of each naming kind
 * and append a `name_set` event for every channel whose value changed.
 *
 * Why `transcriptPath` and not a re-listing: each caller has already resolved
 * the canonical transcript for THIS session (SessionStart via its own
 * `locateTranscript`, UserPromptSubmit from the hook payload's
 * `transcript_path`), and that is the file Claude Code is actively writing.
 * Older transcript files in the workspace dir are historical — we keep them
 * indexed in `transcript_files[]` but they are not where the current names get
 * emitted.
 *
 * One event per changed channel. In the steady state that is zero events (the
 * name has not changed since the previous call) or one; three would mean all
 * three surfaces changed at once, which is not a case worth batching for.
 *
 * No-op cases (all silent — hook exit-0 contract):
 *  - transcriptPath missing or null
 *  - tail window holds no naming record at all
 *  - the value is unchanged from what the projection already has
 *  - the value fails validation (see below)
 *
 * Over-long values are dropped rather than truncated. A truncated name is a
 * name the user never chose, and storing one would also make every subsequent
 * comparison a mismatch. The measured ceiling on this machine is 62
 * characters against a 512-character cap, so this path is defensive, not hot.
 */
export async function harvestNames({ stableId, transcriptPath, recordTargetOpts }) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return;
  if (!existsSync(transcriptPath)) return;

  const titles = extractLatestTitles(transcriptPath);
  if (!titles) return;

  // Channel ← record kind ← authorship. `agent-name` is recorded as `harvest`
  // rather than `human` or `llm`: it is assigned by the agent-team machinery,
  // so neither a person nor a model authored it as a name. It is also
  // deliberately outside the display chain (lib/names.mjs explains why —
  // measured, it mirrors `ai_title` exactly).
  //
  // `custom-title` is the field a person types into, EXCEPT for the one shape
  // Claude Code writes into it itself when a session is resumed from the
  // picker. That one is demoted to `harvest` — see
  // `isMachineGeneratedCustomTitle`.
  //
  // Values are sanitised here, before the change comparison, and not only
  // inside `nameSetPayload`. Comparing a raw transcript value against a
  // sanitised stored one would report "changed" on every single call for any
  // session whose title contains a tab or a stray control byte — and since
  // UserPromptSubmit also calls this, "every call" is now every prompt, not
  // every session start.
  const customTitle = sanitizeNameValue(titles.customTitle ?? '');
  const candidates = [
    { channel: CHANNEL_CC_AI_TITLE, value: sanitizeNameValue(titles.aiTitle ?? ''), source: SOURCE_LLM },
    {
      channel: CHANNEL_CC_CUSTOM_TITLE,
      value: customTitle,
      source: isMachineGeneratedCustomTitle(customTitle) ? SOURCE_HARVEST : SOURCE_HUMAN,
    },
    { channel: CHANNEL_AGENT_NAME, value: sanitizeNameValue(titles.agentName ?? ''), source: SOURCE_HARVEST },
  ].filter((c) => isValidNameValue(c.value) && c.value !== null && c.value.length > 0);
  if (candidates.length === 0) return;

  // One load for all three change checks. `currentNameValue` falls back to the
  // legacy top-level fields, so a projection written before `names[]` existed
  // does not look like "every name is new" and re-emit an event for all 355
  // sessions that already have a title.
  let session = null;
  try {
    const projection = await loadProjection(recordTargetOpts);
    session = (projection && projection.sessions && projection.sessions[stableId]) || null;
  } catch {
    // ignore — a failed load only costs us duplicate suppression, and
    // durability of the audit trail is the contract that matters.
  }

  const observedAt = new Date().toISOString();
  for (const { channel, value, source } of candidates) {
    // Suppression has to agree with what the REDUCER calls a change, or the
    // two ends of the model disagree about the same event. `isSameNaming`
    // compares `(value, source)`: the same string attested by a person is a
    // different fact from one a harvester scraped, which is the entire reason
    // the `source` axis exists. A value-only check here therefore swallowed
    // re-attributions — `custom-title` moving between `harvest` and `human`
    // when `isMachineGeneratedCustomTitle` reclassifies it — and the stale
    // author label then stayed on the record permanently, because the write
    // that would have corrected it was never made.
    //
    // The author is only compared when the record HAS one. A pre-0.3.0 record
    // carries the legacy mirror and no entry, so it has no opinion about
    // authorship; demanding a match there would make every one of those
    // sessions look re-attributed and re-emit for all of them, which is the
    // regression `currentNameValue`'s fallback exists to prevent.
    const stored = session ? findNameEntry(session, channel) : null;
    const sameValue = !!session && currentNameValue(session, channel) === value;
    if (sameValue && (!stored || stored.source === source)) continue;

    const event = newEvent({
      op: 'name_set',
      stable_id: stableId,
      payload: nameSetPayload({
        channel,
        value,
        source,
        observedFrom: transcriptPath,
        observedAt,
      }),
    });

    // tryUpdateProjection holds the lock across append + apply + save, so
    // concurrent hooks cannot clobber each other's write.
    try {
      await tryUpdateProjection(event, { ...recordTargetOpts, lockTimeoutMs: 1500 });
    } catch {
      // exit-0 — durability is still ensured by tryUpdateProjection's
      // SSoT-first ordering; the next hook converges.
    }
  }
}
