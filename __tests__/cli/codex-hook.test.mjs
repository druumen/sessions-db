import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { runCodexHook } from '../../lib/codex-hook.mjs';
import { runIngestCodex } from '../../lib/ingest-codex.mjs';
import { loadProjection, saveProjection, lockPathFor } from '../../lib/storage.mjs';
import { emptyProjection } from '../../lib/projection.mjs';

const ID = '01a0f10c-3a42-75a0-bdb2-e3f18765a655';
const CLI = new URL('../../cli/sessions-db.mjs', import.meta.url);
const HOOK = new URL('../../cli/sessions-db-codex-hook.mjs', import.meta.url);
const T0 = '2026-09-30T08:00:00.000Z';
const T1 = '2026-09-30T09:00:00.000Z';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-hook-test-')));
  const ws = join(root, 'workspace');
  mkdirSync(ws); writeFileSync(join(ws, 'CLAUDE.md'), 'Druumen Workspace');
  return { root, ws, input: { hook_event_name: 'UserPromptSubmit', session_id: ID, cwd: ws,
    prompt: '查找这次会话', transcript_path: join(root, 'rollout.jsonl') },
    storage: { rootPath: join(ws, '.dru-code') } };
}
test('hook CLI → search CLI finds the full Codex UUID; concurrent hooks share one identity', async () => {
  const f = fixture();
  try {
    const options = { env: {}, now: T0 };
    const results = await Promise.all(Array.from({ length: 4 }, () => runCodexHook(f.input, options)));
    assert.equal(new Set(results.map(r => r.stable_id)).size, 1);
    let p = await loadProjection(f.storage);
    assert.equal(Object.keys(p.sessions).length, 1);
    const s = Object.values(p.sessions)[0];
    assert.deepEqual(s.codex_session_ids, [ID]); assert.deepEqual(s.claude_session_ids, []);
    assert.equal(s.first_prompt_preview, f.input.prompt);
    await runCodexHook({ ...f.input, hook_event_name: 'Stop', prompt: undefined }, { env: {}, now: T1 });
    p = await loadProjection(f.storage);
    assert.equal(p.sessions[s.stable_id].created_at, T0);
    assert.equal(p.sessions[s.stable_id].last_progress_at, T1);
    const r = spawnSync(process.execPath, [CLI.pathname, 'search', ID.toUpperCase(), '--json'], {
      cwd: f.ws, encoding: 'utf8', env: { ...process.env, DRUUMEN_SESSIONS_DB_ROOT: f.storage.rootPath },
    });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1); assert.equal(rows[0].stable_id, s.stable_id);
    assert.deepEqual(rows[0].matched_in, ['codex_session_id']);
    const cli = spawnSync(process.execPath, [HOOK.pathname], { input: JSON.stringify(f.input), cwd: f.ws,
      encoding: 'utf8', env: { ...process.env, DRUUMEN_SESSIONS_DB_ROOT: f.storage.rootPath } });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout, '');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('hook updates an already-ingested Codex identity rather than creating another record', async () => {
  const f = fixture();
  try {
    const day = join(f.root, 'rollouts', '2026', '09', '30'); mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-t-${ID}.jsonl`), JSON.stringify({ type: 'session_meta', timestamp: T0,
      payload: { id: ID, cwd: f.ws, timestamp: T0 } }) + '\n');
    const imported = await runIngestCodex({ workspaceRoot: f.ws, storage: f.storage,
      codexRoot: join(f.root, 'rollouts'), dryRun: false, sessionId: ID });
    assert.equal(imported.ingested, 1);
    const seen = await runCodexHook(f.input, { env: {}, now: T1 });
    assert.equal(seen.stable_id, imported.sessions[0].stable_id); assert.equal(seen.created, false);
    const s = Object.values((await loadProjection(f.storage)).sessions);
    assert.equal(s.length, 1); assert.equal(s[0].created_at, T0); assert.equal(s[0].last_progress_at, T1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('same repository worktree uses main database; unrelated repository and personal cwd cannot write it', async () => {
  const f = fixture();
  try {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    const git = args => execFileSync('git', args, { cwd: f.ws, env, stdio: 'pipe' });
    git(['init', '-q']); git(['add', 'CLAUDE.md']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const wt = join(f.root, 'worktree'); git(['worktree', 'add', '--detach', wt]);
    const ok = await runCodexHook({ ...f.input, cwd: wt }, { env: {}, now: T0 });
    assert.equal(ok.storage, f.storage.rootPath);
    assert.equal(existsSync(join(wt, '.dru-code')), false);
    const other = join(f.root, 'other'); mkdirSync(other); writeFileSync(join(other, 'CLAUDE.md'), 'Druumen Workspace');
    await assert.rejects(runCodexHook({ ...f.input, cwd: other }, {
      env: { DRUUMEN_SESSIONS_DB_ROOT: f.storage.rootPath }, now: T1,
    }), /database workspace mismatch/);
    const personal = join(f.root, 'personal'); mkdirSync(personal);
    assert.deepEqual(await runCodexHook({ ...f.input, cwd: personal }, { env: {} }), { skipped: 'workspace' });
    assert.equal(existsSync(join(personal, '.dru-code')), false);
    assert.equal(Object.keys((await loadProjection(f.storage)).sessions).length, 1);
    // A targeted rollout in a sibling worktree belongs to the same main DB.
    const day = join(f.root, 'rollouts', '2026', '09', '30'); mkdirSync(day, { recursive: true });
    const id2 = '01a0f10c-3a42-75a0-bdb2-e3f18765a656';
    writeFileSync(join(day, `rollout-t-${id2}.jsonl`), JSON.stringify({ type: 'session_meta', timestamp: T0,
      payload: { id: id2, cwd: wt } }) + '\n');
    const imported = await runIngestCodex({ workspaceRoot: wt, storage: f.storage,
      codexRoot: join(f.root, 'rollouts'), sessionId: id2, dryRun: false });
    assert.equal(imported.ingested, 1);
    assert.equal(Object.keys((await loadProjection(f.storage)).sessions).length, 2);
    const nested = join(f.ws, 'nested'); mkdirSync(nested);
    writeFileSync(join(nested, 'CLAUDE.md'), 'Druumen Workspace');
    execFileSync('git', ['init', '-q', nested], { env, stdio: 'pipe' });
    await assert.rejects(runCodexHook({ ...f.input, cwd: nested }, {
      env: { DRUUMEN_SESSIONS_DB_ROOT: f.storage.rootPath },
    }), /database workspace mismatch/);
    const sub = join(f.ws, 'sub'); mkdirSync(sub);
    await assert.rejects(runCodexHook(f.input, {
      env: { DRUUMEN_SESSIONS_DB_ROOT: join(sub, '.dru-code') },
    }), /database workspace mismatch/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('targeted ingest scans only the requested rollout, and refuses missing, mismatched and foreign sessions', async () => {
  const f = fixture();
  try {
    const root = join(f.root, 'rollouts'); const day = join(root, '2026', '09', '30'); mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-t-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'), 'deliberately invalid unrelated file');
    const target = join(day, `rollout-t-${ID}.jsonl`);
    const plant = (id, cwd) => writeFileSync(target, JSON.stringify({ type: 'session_meta', timestamp: T0,
      payload: { id, cwd, timestamp: T0 } }) + '\n');
    const run = () => runIngestCodex({ workspaceRoot: f.ws, storage: f.storage, codexRoot: root, sessionId: ID });
    assert.equal((await run()).refused, 'session_not_found');
    plant('ffffffff-ffff-ffff-ffff-ffffffffffff', f.ws);
    assert.equal((await run()).refused, 'session_id_mismatch');
    const other = join(f.root, 'other'); mkdirSync(other); writeFileSync(join(other, 'CLAUDE.md'), 'Druumen Workspace');
    plant(ID, other); assert.equal((await run()).refused, 'session_unavailable');
    plant(ID, f.ws);
    const ok = await run(); assert.equal(ok.ingested, 1); assert.equal(ok.scanned, 1); assert.equal(ok.unparseable, 0);
    assert.equal(existsSync(f.storage.rootPath), false, 'default dry run writes nothing');
    const cli = spawnSync(process.execPath, [CLI.pathname, 'ingest-codex', '--session-id', ID, '--codex-root', root, '--yes', '--json'], {
      cwd: f.ws, encoding: 'utf8', env: { ...process.env, DRUUMEN_SESSIONS_DB_ROOT: f.storage.rootPath },
    });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).ingested, 1);
    const missing = spawnSync(process.execPath, [CLI.pathname, 'ingest-codex', '--session-id', 'ffffffff-ffff-ffff-ffff-fffffffffffe', '--codex-root', root, '--json'], {
      cwd: f.ws, encoding: 'utf8', env: { ...process.env, DRUUMEN_SESSIONS_DB_ROOT: f.storage.rootPath },
    });
    assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).refused, 'session_not_found');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('privacy opt-out, subagent parent IDs and malformed input do not get silently registered', async () => {
  const f = fixture();
  try {
    await runCodexHook(f.input, { env: { DRUUMEN_SESSIONS_DB_STORE_PREVIEW: 'false' }, now: T0 });
    const s = Object.values((await loadProjection(f.storage)).sessions)[0]; assert.equal(s.first_prompt_preview, null);
    assert.deepEqual(await runCodexHook({ ...f.input, agent_id: 'child' }), { skipped: 'event' });
    const cli = spawnSync(process.execPath, [HOOK.pathname], { input: '{broken', encoding: 'utf8' });
    assert.equal(cli.status, 1); assert.match(cli.stderr, /missing or malformed/);
    assert.equal(cli.stdout, '');
    await assert.rejects(runCodexHook({ ...f.input, session_id: 'wrong' }), /session_id/);
    // Disk failure lands on the append, after the existing projection has loaded.
    const events = join(f.storage.rootPath, 'sessions-db-events.jsonl');
    const before = readFileSync(events, 'utf8'); rmSync(events); mkdirSync(events);
    await assert.rejects(runCodexHook(f.input, { env: {} }), /EISDIR/);
    rmSync(events, { recursive: true }); writeFileSync(events, before);
    assert.equal(existsSync(lockPathFor(f.storage)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('historical ingest racing live hooks still commits a single identity', async () => {
  const f = fixture();
  try {
    const day = join(f.root, 'rollouts', '2026', '09', '30'); mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-t-${ID}.jsonl`), JSON.stringify({ type: 'session_meta', timestamp: T0,
      payload: { id: ID, cwd: f.ws, timestamp: T0 } }) + '\n');
    await Promise.all([
      runCodexHook(f.input, { env: {}, now: T1 }),
      runIngestCodex({ workspaceRoot: f.ws, storage: f.storage, codexRoot: join(f.root, 'rollouts'), sessionId: ID, dryRun: false }),
      runIngestCodex({ workspaceRoot: f.ws, storage: f.storage, codexRoot: join(f.root, 'rollouts'), sessionId: ID, dryRun: false }),
    ]);
    const sessions = Object.values((await loadProjection(f.storage)).sessions);
    assert.equal(sessions.length, 1);
    const followup = await runCodexHook(f.input, { env: {}, now: T1 });
    assert.equal(followup.stable_id, sessions[0].stable_id);
    assert.equal(sessions[0].last_progress_at, T1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('legacy database remains the reader and writer target, including when both layouts exist', async () => {
  const f = fixture();
  try {
    const legacy = { root: f.ws };
    await saveProjection(emptyProjection(), legacy);
    await saveProjection(emptyProjection(), f.storage);
    const result = await runCodexHook(f.input, { env: {}, now: T0 });
    assert.equal(result.storage, join(f.ws, 'tickets', '_logs'));
    assert.equal(Object.keys((await loadProjection(f.storage)).sessions).length, 0);
    const env = { ...process.env, DRUUMEN_SESSIONS_DB_ROOT: '' };
    const r = spawnSync(process.execPath, [CLI.pathname, 'search', ID, '--json'], { cwd: f.ws, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].stable_id, result.stable_id);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
