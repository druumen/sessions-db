/**
 * Generate a fresh `sess_<uuidv7>` string.
 * @returns {string}
 */
export function generateSessionId(): string;
/**
 * Validate a sessions-db session id.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isSessionId(s: unknown): boolean;
/**
 * Extract the embedded unix-ms timestamp from a UUIDv7 session id.
 * @param {string} sessionId
 * @returns {number} unix ms
 */
export function extractTimestamp(sessionId: string): number;
