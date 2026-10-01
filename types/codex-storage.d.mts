/** @param {{storage?: object, payload: object, ts: string, onlyNew?: boolean,
 * lockTimeoutMs?: number,readName?:()=>Promise<object|undefined>}} options */
export function recordCodexObservation(options: {
    storage?: object;
    payload: object;
    ts: string;
    onlyNew?: boolean;
    lockTimeoutMs?: number;
    readName?: () => Promise<object | undefined>;
}): Promise<{
    ok: boolean;
    skipped: boolean;
    stable_id: any;
    created: boolean;
}>;
