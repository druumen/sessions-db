/** Missing index is distinct from an index that contains no matching name.
 * I/O errors propagate. A malformed unrelated row is ignored; an invalid
 * requested row never clears a name. Later valid rows supersede earlier rows.
 * @param {string[]} sessionIds
 * @param {{codexHome?:string}} options
 */
export function readCodexThreadNames(sessionIds: string[], options?: {
    codexHome?: string;
}): Promise<{
    available: boolean;
    indexPath: any;
    names: Map<any, any>;
    malformed: number;
}>;
/** Called while the caller holds the projection lock. */
export function codexNameEvent(session: any, payload: any, ts: any): {
    ts: string;
    event_id: string;
    op: string;
    stable_id: string;
    payload: any;
};
/** Refresh only Codex identities already present in this database. No new
 * sessions, rollout scans, activity bump or Claude naming changes.
 * @param {{storage?:object,codexHome?:string,sessionId?:string,dryRun?:boolean,now?:string}} options
 */
export function syncCodexNames(options?: {
    storage?: object;
    codexHome?: string;
    sessionId?: string;
    dryRun?: boolean;
    now?: string;
}): Promise<{
    dryRun: boolean;
    considered: number;
    changed: number;
    missing: number;
    malformed: number;
    sessions: any[];
}>;
