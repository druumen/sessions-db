import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceHashFromCwd } from '../../lib/transcript.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../cli/sessions-db.mjs', import.meta.url));

it('preserves full CLI JSON for cache-off/cold/warm, filters, history, order and disk discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-search-cli-'));
  const storage = join(root, 'tickets', '_logs');
  const cacheDir = join(storage, 'sessions-db-search-cache');
  const home = join(root, 'synthetic-home');
  const projects = join(home, '.claude', 'projects');
  const cwd = join(root, 'fake-workspace');
  const ws = join(projects, workspaceHashFromCwd(cwd));
  mkdirSync(storage, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'),
    DRUUMEN_CLAUDE_PROJECTS_ROOT: projects, DRUUMEN_CODEX_SESSIONS_ROOT: join(home, '.codex', 'sessions'),
    DRUUMEN_SESSIONS_DB_ROOT: storage };
  const message = (text) => JSON.stringify({ type: 'user', sessionId: 'disk-sid', message: { content: text } }) + '\n';
  const p1 = join(root, 'claude.jsonl');
  const p2 = join(root, 'codex.jsonl');
  const p3 = join(ws, 'disk.jsonl');
  writeFileSync(p1, message('first NEEDLE 中文 substring') + message('second needle'));
  writeFileSync(p2, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'codex needle 中文' }] } }) + '\n');
  writeFileSync(p3, message('disk needle 中文'));
  const session = (id, extra) => ({ stable_id: id, activity_state: 'active', names: [],
    claude_session_ids: [], codex_session_ids: [], last_progress_at: '2026-10-01T00:00:00Z', ...extra });
  const sessions = {
    old: session('old', { transcript_files: [{ path: p1 }, { path: p2 }], last_progress_at: '2026-09-01T00:00:00Z' }),
    codex: session('codex', { source: 'codex', activity_state: 'archived', transcript_files: [{ path: p2 }] }),
    disk: session('disk', { cwd, claude_session_ids: ['disk-sid'], transcript_files: [] }),
    metadata: session('metadata', { alias: 'needle alias', transcript_files: [] }),
  };
  writeFileSync(join(storage, 'sessions-db.json'), JSON.stringify({ _meta: { schema_version: 2, names_model_version: 1 }, sessions }));
  writeFileSync(join(storage, 'sessions-db-events.jsonl'), [
    { op: 'name_set', stable_id: 'old', ts: '2026-09-01T00:00:00Z', payload: { channel: 'alias', value: 'historic needle', source: 'human' } },
    { op: 'name_set', stable_id: 'old', ts: '2026-09-02T00:00:00Z', payload: { channel: 'alias', value: 'new title', source: 'human' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const run = async (args, enabled) => {
    const { stdout, stderr } = await exec(process.execPath, [cli, 'search', ...args, '--json', '--root', root], {
      cwd: root, env: { ...env, DRUUMEN_SESSIONS_DB_SEARCH_CACHE: enabled ? '1' : '0' }, timeout: 5000,
    });
    assert.equal(stderr, '');
    return JSON.parse(stdout);
  };
  try {
    for (const args of [
      ['needle', '--content'], ['NEEDLE', '--deep', '--limit', '2'], ['中', '--content'],
      ['substring', '--content', '--source', 'claude'], ['needle', '--content', '--source', 'codex'],
      ['needle', '--content', '--state', 'archived'], ['needle', '--content', '--include-history'],
      ['historic', '--content', '--include-history'], ['needle', '--content', '--max-file-mb', '0.00001'],
      ['absent', '--content'], ['first NEEDLE', '--content'],
    ]) {
      rmSync(cacheDir, { recursive: true, force: true });
      const original = await run(args, false);
      assert.deepEqual(await run(args, true), original);
      assert.deepEqual(await run(args, true), original);
      if (args[0] === 'needle' && args.length === 2) {
        assert.deepEqual(original.map((r) => r.stable_id), ['metadata', 'codex', 'disk', 'old']);
        assert.equal(original.find((r) => r.stable_id === 'old').snippet, 'first NEEDLE 中文 substring');
        assert.deepEqual(original.find((r) => r.stable_id === 'disk').matched_in, ['content(disk)']);
      }
    }
    // Separate processes race population; none may emit malformed/partial results.
    rmSync(cacheDir, { recursive: true, force: true });
    const expected = await run(['absent', '--content'], false);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => run(['absent', '--content'], true)));
    for (const actual of concurrent) assert.deepEqual(actual, expected);
    assert.ok(readdirSync(cacheDir).filter((f) => f.endsWith('.bin')).length <= 1024);
    assert.ok(readdirSync(cacheDir).filter((f) => f.endsWith('.bin')).reduce((n, f) => n + statSync(join(cacheDir, f)).size, 0) <= 128 * 1024 * 1024);
    assert.equal(readdirSync(cacheDir).some((f) => f.includes('.tmp.')), false);
    assert.equal(readFileSync(join(storage, 'sessions-db-events.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
