/** Index only the current runtime's hook payload. No transcript scan.
 * Identity lookup and writes share one projection lock, including concurrent
 * SessionStart/UserPromptSubmit/Stop calls and already-ingested identities.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { druumenWorkspaceRoot, isPreviewDisabled, looksLikeUuid } from './hook-common.mjs';
import { gitWorkspace, isWorkspaceCheckout, storageWorkspaceRoot } from './ingest-codex.mjs';
import { recordCodexObservation } from './codex-storage.mjs';
import { sanitizeFirstPrompt } from './sanitize.mjs';
import { readCodexThreadNames } from './codex-names.mjs';

export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];

/** @param {object} input
 * @param {{env?: object, now?: string, lockTimeoutMs?: number}} options */
export async function runCodexHook(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid hook input');
  if (!CODEX_HOOK_EVENTS.includes(input.hook_event_name) || input.agent_id) return { skipped: 'event' };
  if (!looksLikeUuid(input.session_id)) throw new Error('invalid Codex session_id');
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) throw new Error('invalid hook cwd');
  const workspace = druumenWorkspaceRoot(input.cwd);
  if (!workspace) return { skipped: 'workspace' };
  const env = options.env ?? process.env;
  const git = gitWorkspace(input.cwd);
  const main = git ? dirname(git.commonDir) : workspace;
  // Separate-git-dir / bare layouts cannot use common-dir's parent as a
  // workspace. Fall back to the validated checkout rather than guess a path.
  const owner = druumenWorkspaceRoot(main) === main && isWorkspaceCheckout(main, input.cwd) ? main : workspace;
  // At the owning checkout, use the reader's legacy-before-new precedence.
  // Never create a second .dru-code DB hidden by initialized tickets/_logs.
  const legacy = join(owner, 'tickets', '_logs');
  const storage = { rootPath: resolve(env.DRUUMEN_SESSIONS_DB_ROOT ||
    (existsSync(join(legacy, 'sessions-db.json')) ? legacy : join(owner, '.dru-code'))) };
  if (!isWorkspaceCheckout(storageWorkspaceRoot(storage), input.cwd)) throw new Error('database workspace mismatch');
  if (input.transcript_path != null &&
    (typeof input.transcript_path !== 'string' || !isAbsolute(input.transcript_path))) {
    throw new Error('invalid transcript_path');
  }
  const uuid = input.session_id.toLowerCase();
  const ts = options.now ?? new Date().toISOString();
  const preview = input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string' &&
    !isPreviewDisabled(env.DRUUMEN_SESSIONS_DB_STORE_PREVIEW) ? sanitizeFirstPrompt(input.prompt) : null;
  const result = await recordCodexObservation({ storage, ts, lockTimeoutMs: options.lockTimeoutMs, payload: {
    codex_session_id: uuid, cwd: input.cwd, started_at: ts,
    first_prompt_preview: preview || null, transcript_file: input.transcript_path || null,
  }, readName: async () => (await readCodexThreadNames([uuid], { codexHome: env.CODEX_HOME })).names.get(uuid) });
  return { stable_id: result.stable_id, created: result.created, storage: storage.rootPath };
}
