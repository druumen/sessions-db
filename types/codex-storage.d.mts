/** @param {{storage?: object, payload: object, ts: string, onlyNew?: boolean,
 * lockTimeoutMs?: number}} options */
export function recordCodexObservation(options: {
    storage?: object;
    payload: object;
    ts: string;
    onlyNew?: boolean;
    lockTimeoutMs?: number;
}): Promise<{
    ok: boolean;
    skipped: boolean;
    stable_id: any;
    created: boolean;
}>;
