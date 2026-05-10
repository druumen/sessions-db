import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sweepMod from '../../cli/sweep.mjs';
import { loadProjection } from '../../lib/storage.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'sessions-db.mjs');

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';

const DAY_MS = 24 * 60 * 60 * 1000;

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-cli-sweep-'));
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Plant a projection on disk. Mirrors the helper used by write-handlers test
 * but with sweep-specific session shapes (last_progress_at controls age).
 */
function plantProjection(root, sessions, meta = {}) {
  const projDir = join(root, 'tickets/_logs');
  mkdirSync(projDir, { recursive: true });
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  const projection = {
    _meta: {
      schema_version: 2,
      fingerprint_versions: ['first_human_prompt_v1', 'lineage_prefix_v1'],
      updated: new Date().toISOString(),
      event_count: 0,
      last_event_id: null,
      ...meta,
    },
    sessions: byId,
  };
  writeFileSync(join(projDir, 'sessions-db.json'), JSON.stringify(projection));
  return projection;
}

function mkSession(stableId, overrides = {}) {
  return {
    stable_id: stableId,
    alias: null,
    activity_state: 'active',
    outcome: 'open',
    last_progress_at: isoDaysAgo(0),
    created_at: isoDaysAgo(0),
    branch_current: null,
    branch_at_start: null,
    parent_session_id: null,
    parent_candidate_ids: [],
    cwd: null,
    tasks: [],
    projects: [],
    claude_session_ids: [],
    transcript_files: [],
    fingerprints: { first_human_prompt_v1: null, lineage_prefix_v1: null },
    ...overrides,
  };
}

function eventsLines(root) {
  const p = join(root, 'tickets/_logs/sessions-db-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * In-process handler runner — same stub-process pattern as write-handlers
 * tests so we can capture stdout/stderr/exitCode without actually killing
 * the test runner on process.exit().
 */
async function runHandler(mod, argv) {
  const stdout = [];
  const stderr = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExit = process.exit;
  let exitCode = 0;

  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  process.exit = (code) => { exitCode = code || 0; throw { __isExit: true, code: exitCode }; };

  try {
    await mod.run(argv);
  } catch (err) {
    if (!err || err.__isExit !== true) {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      process.exit = origExit;
      throw err;
    }
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
}

describe('sweep handler — in-process', () => {
  it('empty projection → exit 0 with "no transitions" message', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, []);
      const r = await runHandler(sweepMod, ['--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /no transitions needed/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run does not write events.jsonl even with planned transitions', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        // Aged 60 days → would transition active → archived.
        mkSession(SID_A, { last_progress_at: isoDaysAgo(60) }),
      ]);
      const r = await runHandler(sweepMod, ['--root', root, '--dry-run']);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /1 transition planned/);
      assert.match(r.stdout, /active → archived/);
      assert.equal(eventsLines(root).length, 0);
      // Projection unchanged on disk.
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].activity_state, 'active');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('real sweep writes one event per transition + updates projection', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(2) }),    // stays active
        mkSession(SID_B, { last_progress_at: isoDaysAgo(20) }),   // → idle
        mkSession(SID_C, {
          activity_state: 'idle',
          last_progress_at: isoDaysAgo(45),
        }),                                                        // → archived
      ]);
      const r = await runHandler(sweepMod, ['--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /2 of 2 transitions applied/);
      assert.match(r.stdout, /1 to idle, 1 to archived/);

      const events = eventsLines(root);
      assert.equal(events.length, 2);
      const byTarget = Object.fromEntries(
        events.map((e) => [e.stable_id, e]),
      );
      assert.equal(byTarget[SID_B].op, 'sweep');
      assert.equal(byTarget[SID_B].payload.activity_state, 'idle');
      assert.equal(byTarget[SID_C].op, 'sweep');
      assert.equal(byTarget[SID_C].payload.activity_state, 'archived');

      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].activity_state, 'active');
      assert.equal(proj.sessions[SID_B].activity_state, 'idle');
      assert.equal(proj.sessions[SID_C].activity_state, 'archived');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('idempotent: second sweep run after first writes nothing', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(20) }),
      ]);
      const r1 = await runHandler(sweepMod, ['--root', root]);
      assert.equal(r1.exitCode, 0);
      assert.equal(eventsLines(root).length, 1);

      const r2 = await runHandler(sweepMod, ['--root', root]);
      assert.equal(r2.exitCode, 0);
      assert.match(r2.stdout, /no transitions needed/);
      assert.equal(eventsLines(root).length, 1, 'no new event appended');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--idle-threshold-days override forces an early transition', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(8) }),
      ]);
      // Default: 8d < 14d → no transition. With --idle-threshold-days 7,
      // 8d >= 7 → idle.
      const r = await runHandler(sweepMod, [
        '--root', root, '--idle-threshold-days', '7',
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].activity_state, 'idle');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--archive-threshold-days override forces an archived transition', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(20) }),
      ]);
      // Default: 20d would idle. With --archive-threshold-days 15 (and idle
      // 7), 20d >= 15 → archived.
      const r = await runHandler(sweepMod, [
        '--root', root,
        '--idle-threshold-days', '7',
        '--archive-threshold-days', '15',
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].activity_state, 'archived');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--json structures the dry-run plan', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(50) }),
      ]);
      const r = await runHandler(sweepMod, ['--root', root, '--dry-run', '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.dry_run, true);
      assert.equal(parsed.count, 1);
      assert.equal(parsed.transitions[0].stable_id, SID_A);
      assert.equal(parsed.transitions[0].to_state, 'archived');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--json structures the real sweep summary', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(20) }),
        mkSession(SID_B, { last_progress_at: isoDaysAgo(40) }),
      ]);
      const r = await runHandler(sweepMod, ['--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.summary.total, 2);
      assert.equal(parsed.summary.applied, 2);
      assert.equal(parsed.summary.failed, 0);
      assert.equal(parsed.summary.to_idle, 1);
      assert.equal(parsed.summary.to_archived, 1);
      assert.equal(parsed.applied.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects _meta.idle_threshold_days when no flag is provided', async () => {
    const root = mkTmp();
    try {
      plantProjection(
        root,
        [mkSession(SID_A, { last_progress_at: isoDaysAgo(5) })],
        { idle_threshold_days: 3, archive_threshold_days: 30 },
      );
      const r = await runHandler(sweepMod, ['--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].activity_state, 'idle');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects --idle-threshold-days 0 with exit 2', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, []);
      const r = await runHandler(sweepMod, [
        '--root', root, '--idle-threshold-days', '0',
      ]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /must be a positive number/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects --archive-threshold-days < --idle-threshold-days', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, []);
      const r = await runHandler(sweepMod, [
        '--root', root,
        '--idle-threshold-days', '14',
        '--archive-threshold-days', '7',
      ]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /must be >= --idle-threshold-days/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--quiet swallows stdout but preserves exit code', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(20) }),
      ]);
      const r = await runHandler(sweepMod, ['--root', root, '--quiet']);
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--help prints usage and exits 0', async () => {
    const r = await runHandler(sweepMod, ['--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^Usage: sessions-db sweep/);
    assert.match(r.stdout, /--idle-threshold-days/);
  });
});

// ---------------------------------------------------------------------------
// CLI dispatcher integration — spawn the real CLI and verify end-to-end.
// ---------------------------------------------------------------------------

function runCLI(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI hung > 5000ms'));
    }, 5000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code,
      });
    });
  });
}

describe('sweep handler — spawned CLI integration', () => {
  it('end-to-end: dry-run → real sweep → idempotent re-run', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { last_progress_at: isoDaysAgo(40) }),
      ]);

      const dry = await runCLI(['sweep', '--root', root, '--dry-run']);
      assert.equal(dry.exitCode, 0, `dry stderr: ${dry.stderr}`);
      assert.match(dry.stdout, /1 transition planned/);

      const real = await runCLI(['sweep', '--root', root]);
      assert.equal(real.exitCode, 0, `real stderr: ${real.stderr}`);
      assert.match(real.stdout, /1 of 1 transition applied/);

      const again = await runCLI(['sweep', '--root', root]);
      assert.equal(again.exitCode, 0);
      assert.match(again.stdout, /no transitions needed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
