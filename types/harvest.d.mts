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
export function harvestFromTranscript({ stableId, transcriptPath, recordTargetOpts, dryRun }: {
    stableId: any;
    transcriptPath: any;
    recordTargetOpts: any;
    dryRun?: boolean;
}): Promise<any[]>;
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
export function runHarvest(opts?: {
    root?: string;
    rootPath?: string;
    paths?: object;
    dryRun?: boolean;
    limit?: number;
}): Promise<{
    ok: boolean;
    dryRun: boolean;
    scanned: number;
    withTranscript: number;
    changed: number;
    events: number;
    sessions: Array<{
        stable_id: string;
        transcript: string;
        ops: string[];
    }>;
}>;
