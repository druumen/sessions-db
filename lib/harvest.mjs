/**
 * Shared transcript harvesting — the facts Claude Code writes into a session's
 * transcript about the session itself: its names (`ai-title`, `custom-title`,
 * `agent-name` → `name_set` events) and the merge requests it opened
 * (`pr-link` → `pr_link_seen` events).
 *
 * One tail scan feeds both. That is the whole reason they live together: the
 * read is the expensive part of a harvest (see the budget note in
 * `cli/sessions-db-user-prompt-main.mjs`), so a second scan for a second kind
 * of fact would double the only cost that matters.
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
 *
 * ## Return value and `dryRun`
 *
 * Returns the events it decided to write — the hooks ignore it, `sessions-db
 * harvest` prints it. `dryRun: true` decides everything exactly the same way
 * and skips only the write, which is the point: a backfill preview that ran
 * different code from the backfill would be a preview of nothing.
 */

import { existsSync } from 'node:fs';

import { extractLatestTitles, findTranscriptByCsid, isMachineGeneratedCustomTitle } from './transcript.mjs';
import { applyPrLinkToSession, prLinkFromEvent, prLinkSeenPayload } from './pr-links.mjs';
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
export async function harvestFromTranscript({ stableId, transcriptPath, recordTargetOpts, dryRun = false }) {
  const planned = [];
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return planned;
  if (!existsSync(transcriptPath)) return planned;

  const titles = extractLatestTitles(transcriptPath);
  if (!titles) return planned;

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
  // Nothing to do only when BOTH halves are empty. This used to be
  // `candidates.length === 0`, which was correct while the function only
  // harvested names and silently wrong the moment it also harvested links: a
  // session that opened an MR before Claude Code named it — the ordinary case
  // for a short session — returned here and its link was never recorded.
  if (candidates.length === 0 && (titles.prLinks ?? []).length === 0) return planned;

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

    planned.push(event);
    if (dryRun) continue;

    // tryUpdateProjection holds the lock across append + apply + save, so
    // concurrent hooks cannot clobber each other's write.
    try {
      await tryUpdateProjection(event, { ...recordTargetOpts, lockTimeoutMs: 1500 });
    } catch {
      // exit-0 — durability is still ensured by tryUpdateProjection's
      // SSoT-first ordering; the next hook converges.
    }
  }

  // ---------------------------------------------------------------------
  // Merge requests, from the same scan.
  //
  // Suppression here does not re-implement "is this a change" — it ASKS the
  // reducer, by applying the candidate to a throwaway copy of the stored
  // list.
  //
  // Like the names half, the decision happens OUTSIDE the projection lock, so
  // two harvests racing on the same session can both decide "new" and both
  // append (measured: two concurrent `harvest --yes` runs wrote 4
  // `pr_link_seen` where 2 was right). The projection still converges — the
  // merge is idempotent — so the cost is log bytes, never correctness. Moving
  // the decision inside the lock would mean holding it across the transcript
  // read, which is the one thing this hook must not do on the user's per-turn
  // latency path. The names half above had to hand-write its comparison and the
  // comment there records what that cost (a value-only check swallowed
  // re-attributions for good). Union-merge has more ways to be a no-op than
  // names do — same link re-emitted, an older observation of a link we
  // already have, a null url arriving after a real one — and every one of
  // them would otherwise append an event per prompt, forever.
  // ---------------------------------------------------------------------
  for (const link of titles.prLinks ?? []) {
    const payload = prLinkSeenPayload({
      repository: link.repository,
      number: link.number,
      url: link.url,
      observedAt: link.observedAt,
      observedFrom: transcriptPath,
    });
    if (!payload) continue;

    const event = newEvent({ op: 'pr_link_seen', stable_id: stableId, payload });
    const probe = { pr_links: JSON.parse(JSON.stringify((session && session.pr_links) || [])) };
    if (!applyPrLinkToSession(probe, prLinkFromEvent(event))) continue;

    planned.push(event);
    // Advance the local copy on BOTH paths so the next iteration compares
    // against what this loop has already decided.
    //
    // ⚠ What this actually buys, measured rather than assumed: it is the cap
    // (`MAX_PR_LINKS_PER_SESSION`) that needs it — without it a dry run over a
    // session already at the cap keeps comparing against the pre-loop list and
    // reports links the real run would refuse. It is NOT needed for
    // de-duplication: `extractLatestTitles` already collapses repeats by
    // (repository, number) before we get here, so an earlier comment claiming
    // "otherwise a dry run reports the first link twice" described a mechanism
    // that does not exist. Verified by deleting the line: dedupe output is
    // byte-identical, the cap behaviour is not (64 vs 70 on a 70-link fixture).
    if (session) session.pr_links = probe.pr_links;
    if (dryRun) continue;

    try {
      await tryUpdateProjection(event, { ...recordTargetOpts, lockTimeoutMs: 1500 });
    } catch {
      // exit-0 — same contract as the names half.
    }
  }

  return planned;
}


/**
 * `sessions-db harvest` — backfill: run the same harvest over transcripts that
 * are already on disk.
 *
 * ## Why a backfill exists at all
 *
 * The hooks only ever see sessions that are still being used. Everything
 * recorded before the harvest ran on every prompt — 289 of 688 records (42%)
 * on the reference machine — has a transcript carrying a title and a
 * projection carrying nothing, and no hook will ever fire for it again. That
 * gap does not close on its own.
 *
 * ## Which transcript
 *
 * By `claude_session_ids` → `findTranscriptByCsid`, an EXACT filename match,
 * not `transcript_files[]`. Measured on the reference machine, 357 of 507
 * entries in that array (70%) name a file that matches none of their record's
 * claude_session_ids; harvesting through it would attribute one session's
 * name to another, and a backfill that mislabels is worse than a gap.
 *
 * Dry run by default is deliberate — same posture as `prune`. This one is not
 * destructive, but it writes a few hundred events into an append-only log,
 * and "let me see it first" is the reasonable default for that.
 *
 * Cost is dominated by one `loadProjection` per session inside
 * `harvestFromTranscript` rather than by the transcript reads: measured
 * 1.9 s over 688 records on the reference machine, which is cheap enough that
 * keeping ONE harvest implementation beats optimising the once-a-lifetime
 * path into a second one.
 *
 * ## Why there is no "only the un-harvested ones" filter
 *
 * There was one, and it was a lie: `!hasHarvestedName || !hasLinks` is true
 * for 688 of 688 records on the reference machine, because most sessions
 * never open an MR and `!hasLinks` is therefore permanently true. The flag
 * that switched it off (`--all`) changed no count on real data — reviewed and
 * measured, both branches produced 688/301/246/376.
 *
 * The honest version is that "already harvested" is not knowable without
 * reading the transcript: a record with no links is indistinguishable from
 * one whose links we have not looked for yet. So the backfill visits
 * everything, and the per-event suppression — which asks the reducer, not a
 * heuristic — is what keeps a re-run from writing anything. At 1.9 s over 688
 * records that is cheap enough to be the whole design.
 *
 * @param {{root?: string, rootPath?: string, paths?: object, dryRun?: boolean,
 *   limit?: number}} [opts]
 * @returns {Promise<{ok: boolean, dryRun: boolean, scanned: number,
 *   withTranscript: number, changed: number, events: number,
 *   sessions: Array<{stable_id: string, transcript: string, ops: string[]}>}>}
 */
export async function runHarvest(opts = {}) {
  const storage = {};
  if (opts.rootPath !== undefined) storage.rootPath = opts.rootPath;
  if (opts.root !== undefined) storage.root = opts.root;
  if (opts.paths !== undefined) storage.paths = opts.paths;

  const dryRun = opts.dryRun !== false;
  const projection = await loadProjection(storage);
  const sessions = (projection && projection.sessions) || {};

  const out = { ok: true, dryRun, scanned: 0, withTranscript: 0, changed: 0, events: 0, sessions: [] };
  let budget = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;

  for (const [stableId, session] of Object.entries(sessions)) {
    if (budget <= 0) break;
    out.scanned += 1;

    const transcriptPath = firstTranscriptOnDisk(session);
    if (!transcriptPath) continue;
    out.withTranscript += 1;
    budget -= 1;

    const events = await harvestFromTranscript({
      stableId,
      transcriptPath,
      recordTargetOpts: storage,
      dryRun,
    });
    if (events.length === 0) continue;
    out.changed += 1;
    out.events += events.length;
    out.sessions.push({
      stable_id: stableId,
      transcript: transcriptPath,
      ops: events.map((e) => `${e.op}:${e.payload.channel ?? formatPlannedLink(e.payload)}`),
    });
  }
  return out;
}

function formatPlannedLink(payload) {
  return payload && payload.number !== undefined ? `#${payload.number}` : '?';
}

/**
 * The session's transcript, resolved by claude_session_id and required to
 * exist. Returns null rather than guessing — a backfill with no file is a
 * no-op, which is the correct outcome for a session whose transcript was
 * rotated away.
 */
function firstTranscriptOnDisk(session) {
  const ids = Array.isArray(session.claude_session_ids) ? session.claude_session_ids : [];
  for (const id of ids) {
    const p = findTranscriptByCsid(id);
    if (p && existsSync(p)) return p;
  }
  return null;
}
