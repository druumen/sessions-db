/** Codex keeps renamed thread names in session_index.jsonl, separate from
 * rollouts. Read metadata only and retain only explicitly requested UUIDs.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { looksLikeUuid } from './hook-common.mjs';
import { sanitizeNameValue } from './sanitize.mjs';
import { isValidNameValue, isIso8601, CHANNEL_CODEX_THREAD_NAME, SOURCE_HARVEST,
  findNameEntry, nameSetPayload } from './names.mjs';
import { loadProjection, newEvent, appendEvent, saveProjection, lockPathFor } from './storage.mjs';
import { acquireLock } from './lock.mjs';
import { applyEvent } from './projection.mjs';

/** Missing index is distinct from an index that contains no matching name.
 * I/O errors propagate. A malformed unrelated row is ignored; an invalid
 * requested row never clears a name. Later valid rows supersede earlier rows.
 * @param {string[]} sessionIds
 * @param {{codexHome?:string}} options
 */
export async function readCodexThreadNames(sessionIds, options = {}) {
  const wanted = new Set(sessionIds.filter(looksLikeUuid).map(id => id.toLowerCase()));
  const indexPath = join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'session_index.jsonl');
  const names = new Map();
  const stream = createReadStream(indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let malformed = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { malformed += 1; continue; }
      if (!row || typeof row.id !== 'string' || !wanted.has(row.id.toLowerCase())) continue;
      if (row.thread_name !== null && typeof row.thread_name !== 'string') { malformed += 1; continue; }
      const value = row.thread_name === null ? null : sanitizeNameValue(row.thread_name) || null;
      if (row.thread_name && value === null) { malformed += 1; continue; }
      if (!isValidNameValue(value) || !isIso8601(row.updated_at)) { malformed += 1; continue; }
      names.set(row.id.toLowerCase(), nameSetPayload({
        channel: CHANNEL_CODEX_THREAD_NAME, value, source: SOURCE_HARVEST,
        observedFrom: indexPath, observedAt: new Date(row.updated_at).toISOString(),
      }));
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, indexPath, names, malformed };
    throw error;
  } finally { lines.close(); stream.destroy(); }
  return { available: true, indexPath, names, malformed };
}

/** Called while the caller holds the projection lock. */
export function codexNameEvent(session, payload, ts) {
  if (!payload) return null;
  const current = findNameEntry(session, CHANNEL_CODEX_THREAD_NAME);
  if (current?.value === payload.value && current?.source === payload.source) return null;
  // A missing name is not an initial rename to nothing.
  if (!current && payload.value === null) return null;
  return newEvent({ op: 'name_set', stable_id: session.stable_id, ts, payload });
}

/** Refresh only Codex identities already present in this database. No new
 * sessions, rollout scans, activity bump or Claude naming changes.
 * @param {{storage?:object,codexHome?:string,sessionId?:string,dryRun?:boolean,now?:string}} options
 */
export async function syncCodexNames(options = {}) {
  const storage = options.storage ?? {};
  const lock = await acquireLock(lockPathFor(storage), { timeoutMs: 1500 });
  try {
    const projection = await loadProjection(storage);
    const sessions = Object.values(projection.sessions).filter(s => s.source === 'codex' &&
      (!options.sessionId || s.codex_session_ids?.some(id => id.toLowerCase() === options.sessionId.toLowerCase())));
    if (options.sessionId && sessions.length !== 1) throw new Error('Codex session_id is missing or ambiguous in database');
    const ids = sessions.flatMap(s => s.codex_session_ids ?? []);
    const owners = new Map();
    for (const session of sessions) for (const id of session.codex_session_ids ?? []) {
      const key = id.toLowerCase();
      if (owners.has(key) && owners.get(key) !== session.stable_id) throw new Error('ambiguous Codex session_id in database');
      owners.set(key, session.stable_id);
    }
    const read = await readCodexThreadNames(ids, { codexHome: options.codexHome });
    if (!read.available) throw new Error('Codex session name index is unavailable');
    const result = { dryRun: options.dryRun !== false, considered: sessions.length, changed: 0,
      missing: 0, malformed: read.malformed, sessions: [] };
    for (const session of sessions) {
      const candidates = (session.codex_session_ids ?? []).map(id => read.names.get(id.toLowerCase())).filter(Boolean);
      if (!candidates.length) { result.missing += 1; continue; }
      // Multiple UUIDs in an identity use the newest attested name.
      candidates.sort((a,b) => a.observed_at.localeCompare(b.observed_at));
      const event = codexNameEvent(session, candidates.at(-1), options.now ?? new Date().toISOString());
      if (!event) continue;
      result.changed += 1;
      result.sessions.push({ stable_id: session.stable_id, value: event.payload.value });
      if (!result.dryRun) { await appendEvent(event, storage); applyEvent(projection, event); }
    }
    if (!result.dryRun && result.changed) await saveProjection(projection, { ...storage, withLock: false });
    return result;
  } finally { lock.release(); }
}
