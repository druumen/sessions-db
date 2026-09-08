import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isInside, runIngestCodex } from '../../lib/ingest-codex.mjs';
import { searchByMetadata } from '../../cli/search.mjs';
import { loadProjection } from '../../lib/storage.mjs';

const CODEX_ID = '01a07d1a-4180-7ab3-be8c-336dc7f2bab3';
const CODEX_ID_2 = '01a07d1a-4180-7ab3-be8c-336dc7f2bac4';

const mkTmp = (p = 'ingest-codex-') => mkdtempSync(join(tmpdir(), p));

/** A directory that passes `isDruumenWorkspace` (CLAUDE.md sentinel). */
function mkWorkspace(prefix = 'ws-') {
  const dir = mkTmp(prefix);
  writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\nThis is a Druumen Workspace fixture.\n');
  return dir;
}

function plantRollout(codexRoot, { id = CODEX_ID, cwd, startedAt = '2026-04-25T07:01:39.927Z',
  lastAt = '2026-04-25T07:25:51.050Z', prompt = '真正的第一句话', originator = 'Claude Code' } = {}) {
  const dir = join(codexRoot, '2026', '04', '25');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-04-25T07-01-39-${id}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ timestamp: startedAt, ordinal: 0, type: 'session_meta',
      payload: { id, timestamp: startedAt, cwd, originator, cli_version: '0.153.4', thread_source: null } }),
    JSON.stringify({ timestamp: '2026-04-25T07:09:00.000Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ text: '<recommended_plugins>\ninjected' }] } }),
    JSON.stringify({ timestamp: lastAt, type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ text: prompt }] } }),
  ].join('\n') + '\n');
  return path;
}

const eventsPath = (root) => join(root, 'tickets', '_logs', 'sessions-db-events.jsonl');
const readEvents = (root) => (existsSync(eventsPath(root))
  ? readFileSync(eventsPath(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

describe('ingest-codex — isInside', () => {
  it('does not treat a sibling with a shared prefix as inside', () => {
    assert.equal(isInside('/a/workspace', '/a/workspace/sub'), true);
    assert.equal(isInside('/a/workspace', '/a/workspace'), true);
    // The reason this helper exists instead of `startsWith`.
    assert.equal(isInside('/a/workspace', '/a/workspace-old/sub'), false);
  });
});

describe('ingest-codex — the two gates', () => {
  it('registers a rollout whose cwd is inside this workspace', async () => {
    const ws = mkWorkspace();
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: ws });
      const r = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      assert.equal(r.ingested, 1);
      assert.equal(r.skippedNotWorkspace, 0);
      assert.equal(r.skippedOtherWorkspace, 0);

      const proj = await loadProjection({ root: ws });
      const s = Object.values(proj.sessions)[0];
      assert.equal(s.source, 'codex');
      assert.deepEqual(s.codex_session_ids, [CODEX_ID]);
      assert.deepEqual(s.claude_session_ids, [], 'codex ids must not leak into the Claude axis');
      assert.equal(s.first_prompt_preview, '真正的第一句话', 'the injected opener was skipped');
      assert.equal(s.display_name, '真正的第一句话');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });

  it('gate 1: a cwd that is not a Druumen workspace is skipped', async () => {
    const ws = mkWorkspace();
    const outsider = mkTmp('not-a-workspace-'); // no CLAUDE.md
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: outsider });
      const r = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      assert.equal(r.skippedNotWorkspace, 1);
      assert.equal(r.ingested, 0);
      assert.equal(readEvents(ws).length, 0, 'nothing was written');
    } finally {
      for (const d of [ws, outsider, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('gate 2: a Druumen workspace that is NOT this one is skipped', async () => {
    // This is the gate that keeps a personal directory out of a work
    // database. Measured on the reference machine: 896 rollouts span 162
    // distinct cwds, 111 of them a personal (non-work) directory.
    const ws = mkWorkspace('ws-mine-');
    const otherWs = mkWorkspace('ws-personal-'); // passes gate 1, fails gate 2
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: otherWs });
      const r = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      assert.equal(r.skippedOtherWorkspace, 1);
      assert.equal(r.skippedNotWorkspace, 0, 'it IS a workspace — just not this one');
      assert.equal(r.ingested, 0);
      assert.equal(readEvents(ws).length, 0);

      // Control: the same rollout pointed at THIS workspace does land, so the
      // zero above is the gate and not a broken fixture.
      const codexRoot2 = mkTmp('codex-root-');
      plantRollout(codexRoot2, { cwd: ws });
      const ok = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot: codexRoot2, dryRun: false });
      assert.equal(ok.ingested, 1);
      rmSync(codexRoot2, { recursive: true, force: true });
    } finally {
      for (const d of [ws, otherWs, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('ingest-codex — writing', () => {
  it('dry run reports but writes nothing; --yes writes', async () => {
    const ws = mkWorkspace();
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: ws });
      const preview = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot });
      assert.equal(preview.dryRun, true);
      assert.equal(preview.ingested, 1);
      assert.equal(readEvents(ws).length, 0);

      const real = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      assert.equal(real.ingested, 1);
      assert.equal(readEvents(ws).filter((e) => e.op === 'codex_session_seen').length, 1);
    } finally {
      for (const d of [ws, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('dates the record from the rollout, not from the ingest clock', async () => {
    const ws = mkWorkspace();
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: ws, startedAt: '2026-04-25T07:01:39.927Z', lastAt: '2026-04-25T07:25:51.050Z' });
      await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      const s = Object.values((await loadProjection({ root: ws })).sessions)[0];
      // A session from April stays in April. Indexing is not activity — the
      // defect 0.4.0 shipped dated 246 of 246 backfilled records to the
      // moment of the backfill, median +50 days.
      assert.equal(s.last_progress_at, '2026-04-25T07:25:51.050Z');
      assert.equal(s.created_at, '2026-04-25T07:01:39.927Z');
    } finally {
      for (const d of [ws, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second run registers nothing new', async () => {
    const ws = mkWorkspace();
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: ws });
      const first = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      assert.equal(first.ingested, 1, 'control: the first run did write');
      const again = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });
      assert.equal(again.ingested, 0);
      assert.equal(again.alreadyKnown, 1);
      assert.equal(readEvents(ws).filter((e) => e.op === 'codex_session_seen').length, 1);
    } finally {
      for (const d of [ws, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('counts an unreadable rollout instead of silently dropping it', async () => {
    const ws = mkWorkspace();
    const codexRoot = mkTmp('codex-root-');
    try {
      const dir = join(codexRoot, '2026', '04', '25');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-2026-04-25T07-01-39-${CODEX_ID}.jsonl`), '{"type":"event_msg"}\n');
      const r = await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot });
      assert.equal(r.scanned, 1);
      assert.equal(r.unparseable, 1, 'a parser regression must not look like an empty corpus');
      assert.equal(r.ingested, 0);
    } finally {
      for (const d of [ws, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('search — the source axis', () => {
  it('--source separates codex from claude, and no filter returns both', async () => {
    const ws = mkWorkspace();
    const codexRoot = mkTmp('codex-root-');
    try {
      plantRollout(codexRoot, { cwd: ws, id: CODEX_ID, prompt: 'shared needle from codex' });
      plantRollout(codexRoot, { cwd: ws, id: CODEX_ID_2, prompt: 'another codex one' });
      // The second file overwrites the first path unless the name differs;
      // plantRollout keys the filename on the id, so both exist.
      await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });

      const proj = await loadProjection({ root: ws });
      // A hand-planted Claude-side record, so the filter has something to
      // exclude. No `source` field at all — exactly what pre-0.5.0 records
      // look like on disk.
      proj.sessions.sess_claude_fixture = {
        stable_id: 'sess_claude_fixture',
        alias: null, names: [], pr_links: [],
        first_prompt_preview: 'shared needle from claude',
        activity_state: 'active', last_progress_at: '2026-05-01T00:00:00.000Z',
        claude_session_ids: ['aaaaaaaa-1111-2222-3333-444444444444'], transcript_files: [],
      };

      const all = searchByMetadata(proj, 'shared needle');
      assert.equal(all.length, 2, 'no filter returns both');

      const codexOnly = searchByMetadata(proj, 'shared needle', { source: 'codex' });
      assert.deepEqual(codexOnly.map((r) => r.session.source), ['codex']);

      const claudeOnly = searchByMetadata(proj, 'shared needle', { source: 'claude' });
      assert.equal(claudeOnly.length, 1);
      assert.equal(claudeOnly[0].session.stable_id, 'sess_claude_fixture',
        'a record with no source field is claude — it could not have been anything else');
    } finally {
      for (const d of [ws, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * The `--content` tier through the real CLI.
 *
 * Two things only this level can pin: that `recordText` understands the codex
 * record shape at all (a rollout is not a Claude transcript), and that
 * `--source` is applied on the content path too. The content branch iterates
 * the projection itself rather than the metadata results, so its filter is a
 * SECOND copy — and a filter that exists on one of two tiers is a filter that
 * leaks.
 */
describe('search --content over codex rollouts (real CLI)', () => {
  const CLI = new URL('../../cli/sessions-db.mjs', import.meta.url).pathname;

  function runCLI(argv, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...argv], {
        cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out = []; const err = [];
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI hung > 10s')); }, 10000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  }

  it('finds a phrase that only exists inside a rollout body, and honours --source there', async () => {
    const ws = mkWorkspace('ws-content-');
    const codexRoot = mkTmp('codex-root-');
    try {
      // The needle lives ONLY in the rollout body, never in any metadata
      // field, so a metadata-tier hit cannot be mistaken for a content hit.
      const dir = join(codexRoot, '2026', '04', '25');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-2026-04-25T07-01-39-${CODEX_ID}.jsonl`), [
        JSON.stringify({ timestamp: '2026-04-25T07:01:39.927Z', type: 'session_meta',
          payload: { id: CODEX_ID, timestamp: '2026-04-25T07:01:39.927Z', cwd: ws, originator: 'Claude Code' } }),
        JSON.stringify({ timestamp: '2026-04-25T07:09:00.000Z', type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'opening prompt' }] } }),
        JSON.stringify({ timestamp: '2026-04-25T07:10:00.000Z', type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ text: 'the buried phrase zqxjkv lives here' }] } }),
      ].join('\n') + '\n');

      await runIngestCodex({ workspaceRoot: ws, storage: { root: ws }, codexRoot, dryRun: false });

      const found = await runCLI(['search', 'zqxjkv', '--content', '--json'], ws);
      assert.equal(found.code, 0, found.stderr);
      const rows = JSON.parse(found.stdout);
      assert.equal(rows.length, 1, 'the phrase is only in the rollout body');
      assert.equal(rows[0].source, 'codex');
      assert.ok(rows[0].matched_in.some((m) => m.startsWith('content')), rows[0].matched_in.join(','));

      // Same query, restricted to the other source: the content tier must
      // filter too, not just the metadata tier.
      const filtered = await runCLI(['search', 'zqxjkv', '--content', '--source', 'claude', '--json'], ws);
      assert.equal(filtered.code, 0, filtered.stderr);
      assert.deepEqual(JSON.parse(filtered.stdout), []);

      // And a typo'd source is an argparse error, not a silent empty result.
      const typo = await runCLI(['search', 'zqxjkv', '--source', 'codx'], ws);
      assert.equal(typo.code, 2);
      assert.match(typo.stderr, /--source must be one of/);
    } finally {
      for (const d of [ws, codexRoot]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * Cross-feature: `prune`.
 *
 * Every ghost criterion is about Claude Code artefacts — a preview and
 * fingerprints derived from Claude prompts, and a transcript found by
 * `claude_session_id`. A codex record satisfies all of them vacuously, so
 * without an explicit guard the ghost sweep deletes real sessions whose
 * rollout is on disk in a directory that scan never looks at.
 */
describe('prune — a codex record is not a ghost', () => {
  it('spares a codex session that has no first prompt at all', async () => {
    const { computePruneCandidates } = await import('../../lib/prune.mjs');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const base = {
      stable_id: 'sess_codex_ghostlike',
      created_at: old,
      first_prompt_preview: null,      // a rollout of only injected openers
      fingerprints: {},                 // Claude-only concept
      ai_title: null, alias: null, names: [],
      claude_session_ids: [],           // makes every csid-based check vacuous
      tasks: [], projects: [], outcome: 'open',
    };

    const codex = computePruneCandidates(
      { sessions: { sess_codex_ghostlike: { ...base, source: 'codex', codex_session_ids: [CODEX_ID] } } },
      { diskCsids: new Set(), olderThanMs: 60 * 60 * 1000 },
    );
    assert.equal(codex.candidates.length, 0, 'a codex record must never be pruned by these criteria');

    // Control: the identical record without the source field IS a ghost —
    // which is what makes the assertion above about the guard rather than
    // about some unrelated criterion sparing it.
    const claude = computePruneCandidates(
      { sessions: { sess_codex_ghostlike: { ...base } } },
      { diskCsids: new Set(), olderThanMs: 60 * 60 * 1000 },
    );
    assert.equal(claude.candidates.length, 1);
  });
});
