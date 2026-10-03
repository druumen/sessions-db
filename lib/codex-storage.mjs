/** Both live hooks and historical ingest must resolve a Codex identity under
 * the same projection lock. An unlocked lookup followed by a locked write can
 * otherwise split one UUID across two successful registrations.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLock } from './lock.mjs';
import { loadProjection, lockPathFor, newEvent, appendEvent, saveProjection } from './storage.mjs';
import { applyEvent } from './projection.mjs';
import { generateSessionId } from './uuid.mjs';
import { codexNameEvent } from './codex-names.mjs';

/** @param {{storage?: object, payload: object, ts: string, onlyNew?: boolean,
 * lockTimeoutMs?: number,readName?:()=>Promise<object|undefined>}} options */
export async function recordCodexObservation(options) {
  const storage = options.storage ?? {};
  const uuid = options.payload.codex_session_id.toLowerCase();
  const lockPath = lockPathFor(storage);
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = await acquireLock(lockPath, { timeoutMs: options.lockTimeoutMs ?? 1500 });
  try {
    const projection = await loadProjection(storage);
    const existing = Object.values(projection.sessions).filter(s =>
      (s.codex_session_ids ?? []).some(id => id.toLowerCase() === uuid));
    if (existing.length > 1) throw new Error('ambiguous Codex session_id in database');
    const stableId = existing[0]?.stable_id ?? generateSessionId();
    if (existing.length && options.onlyNew) return { ok: true, skipped: true, stable_id: stableId, created: false };
    const name = options.readName ? await options.readName() : null;
    const event = newEvent({ op: 'codex_session_seen', stable_id: stableId, ts: options.ts,
      payload: { ...options.payload, codex_session_id: uuid } });
    await appendEvent(event, storage);
    applyEvent(projection, event);
    const nameEvent = codexNameEvent(projection.sessions[stableId], name, options.ts);
    if (nameEvent) { await appendEvent(nameEvent, storage); applyEvent(projection, nameEvent); }
    await saveProjection(projection, { ...storage, withLock: false });
    return { ok: true, skipped: false, stable_id: stableId, created: existing.length === 0 };
  } finally { lock.release(); }
}
