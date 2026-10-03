/** Search ordered message strings, never concatenating across message boundaries.
 * No cache directory (or DRUUMEN_SESSIONS_DB_SEARCH_CACHE=0 in the CLI) gives
 * the original scanner, useful for diagnosis and differential validation.
 */
export function scanTranscriptContent(path: any, query: any, { cacheDir, limits: overrides, openStream }?: {}): Promise<any>;
