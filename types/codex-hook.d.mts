/** @param {object} input
 * @param {{env?: object, now?: string, lockTimeoutMs?: number}} options */
export function runCodexHook(input: object, options?: {
    env?: object;
    now?: string;
    lockTimeoutMs?: number;
}): Promise<{
    skipped: string;
    stable_id?: undefined;
    created?: undefined;
    storage?: undefined;
} | {
    stable_id: any;
    created: boolean;
    storage: any;
    skipped?: undefined;
}>;
export const CODEX_HOOK_EVENTS: string[];
