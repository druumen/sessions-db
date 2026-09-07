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
export function harvestFromTranscript({ stableId, transcriptPath, recordTargetOpts }: {
    stableId: any;
    transcriptPath: any;
    recordTargetOpts: any;
}): Promise<void>;
