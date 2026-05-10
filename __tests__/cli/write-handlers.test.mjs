import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

import { loadProjection } from '../../lib/storage.mjs';

// Handler modules under test — we import their `run()` functions and drive
// them via tmpdir-isolated --root. We capture stdout/stderr/exit by stubbing
// `process` for the duration of each call.
import * as aliasMod from '../../cli/alias.mjs';
import * as linkMod from '../../cli/link.mjs';
import * as linkParentMod from '../../cli/link-parent.mjs';
import * as closeMod from '../../cli/close.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-cli-'));
}

function plantProjection(root, sessions) {
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
    last_progress_at: '2026-05-09T00:00:00.000Z',
    created_at: '2026-05-09T00:00:00.000Z',
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

/**
 * Run a handler with stdout/stderr/exit captured. Returns
 * { stdout, stderr, exitCode }. The handler's process.exit(code) is rewired
 * to throw a sentinel so we can resume control without killing node --test.
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
  // eslint-disable-next-line no-throw-literal
  process.exit = (code) => { exitCode = code || 0; throw { __isExit: true, code: exitCode }; };

  try {
    await mod.run(argv);
  } catch (err) {
    if (!err || err.__isExit !== true) {
      // restore before rethrow so the test runner reports the real error
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

function eventsLines(root) {
  const p = join(root, 'tickets/_logs/sessions-db-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// alias
// ---------------------------------------------------------------------------
describe('alias handler', () => {
  it('sets a fresh alias and updates projection', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(aliasMod, [SID_A, 'demo-alias', '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /ok: alias_set/);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].alias, 'demo-alias');
      assert.equal(eventsLines(root).length, 1);
      assert.equal(eventsLines(root)[0].op, 'alias_set');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--clear sets alias to null', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { alias: 'old' })]);
      const r = await runHandler(aliasMod, [SID_A, '--clear', '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].alias, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run does not write events.jsonl', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(aliasMod, [SID_A, 'try-it', '--dry-run', '--root', root]);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /\[dry-run\]/);
      assert.equal(eventsLines(root).length, 0);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].alias, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 1 on unknown stable_id', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(aliasMod, ['sess_no-such-id-zzzz-zzzz-zzzzzzzzzzzz', 'x', '--root', root]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /stable_id not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 2 when both alias and --clear given', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(aliasMod, [SID_A, 'foo', '--clear', '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /mutually exclusive/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------
describe('link handler', () => {
  it('adds tasks + projects to the session', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkMod, [
        SID_A,
        '--task', 'feat-foo.md',
        '--project', 'proj-bar',
        '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['feat-foo.md']);
      assert.deepEqual(proj.sessions[SID_A].projects, ['proj-bar']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repeated --task collects multiple', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkMod, [
        SID_A, '--task', 't1.md', '--task', 't2.md', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks.sort(), ['t1.md', 't2.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run prints event without writing', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkMod, [
        SID_A, '--task', 'x.md', '--dry-run', '--root', root,
      ]);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /\[dry-run\]/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 2 when no --task and no --project', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkMod, [SID_A, '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /at least one --task or --project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 1 on unknown stable_id', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkMod, [
        'sess_no-such-id-zzzz-zzzz-zzzzzzzzzzzz', '--task', 'x.md', '--root', root,
      ]);
      assert.equal(r.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P5 reshape (was: P4 reject "--remove not implemented") ---
  // The P4 fast-fail was a temporary defense because `session_link` reducer
  // had no remove path — writing payload.remove=true diverged from projection
  // state. P5 introduces the `session_unlink` event op + reducer; --remove
  // now ships and writes that event instead.
  it('--remove --task X dispatches session_unlink + filters projection.tasks', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, {
        tasks: ['feat-x.md', 'feat-y.md'],
      })]);
      const r = await runHandler(linkMod, [
        SID_A, '--task', 'feat-x.md', '--remove', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /ok: session_unlink written/);
      const events = eventsLines(root);
      assert.equal(events.length, 1);
      assert.equal(events[0].op, 'session_unlink');
      assert.deepEqual(events[0].payload.tasks, ['feat-x.md']);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['feat-y.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--remove --project X also writes session_unlink', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, {
        tasks: ['t1'],
        projects: ['p1', 'p2'],
      })]);
      const r = await runHandler(linkMod, [
        SID_A, '--project', 'p1', '--remove', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const events = eventsLines(root);
      assert.equal(events[0].op, 'session_unlink');
      assert.deepEqual(events[0].payload.projects, ['p1']);
      assert.equal(events[0].payload.tasks, undefined);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].projects, ['p2']);
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--remove with no --task and no --project still exits 2 (no targets)', async () => {
    // The "must have at least one target" check survives — an empty unlink
    // would be a no-op event with no audit value. This is now the ONLY
    // reject path for --remove; the P4 "not implemented" path is gone.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { tasks: ['feat-x.md'] })]);
      const r = await runHandler(linkMod, [SID_A, '--remove', '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /requires at least one --task or --project/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--remove --task X is idempotent: removing a non-existent task is a no-op on projection', async () => {
    // The CLI still writes the event (audit trail is intentional even for
    // no-op unlinks — operator intent is recorded). The reducer skips silently.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A, { tasks: ['t1'] })]);
      const r = await runHandler(linkMod, [
        SID_A, '--task', 't-does-not-exist', '--remove', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['t1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('regression: --task without --remove still adds (P1 session_link path)', async () => {
    // Sanity check that the unlink ship did not break the additive path.
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkMod, [
        SID_A, '--task', 'new-task.md', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const events = eventsLines(root);
      assert.equal(events[0].op, 'session_link');
      const proj = await loadProjection({ root });
      assert.deepEqual(proj.sessions[SID_A].tasks, ['new-task.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// link-parent
// ---------------------------------------------------------------------------
describe('link-parent handler', () => {
  it('sets parent_session_id', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A), mkSession(SID_B)]);
      const r = await runHandler(linkParentMod, [SID_A, SID_B, '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, SID_B);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--remove clears parent', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B),
      ]);
      const r = await runHandler(linkParentMod, [SID_A, '--remove', '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects self-parent (1-cycle)', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkParentMod, [SID_A, SID_A, '--root', root]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /cannot be the same/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 1 when parent does not exist', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(linkParentMod, [
        SID_A, 'sess_no-such-id-zzzz-zzzz-zzzzzzzzzzzz', '--root', root,
      ]);
      assert.equal(r.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run does not write', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A), mkSession(SID_B)]);
      const r = await runHandler(linkParentMod, [SID_A, SID_B, '--dry-run', '--root', root]);
      assert.equal(r.exitCode, 0);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // --- P4 round-1 review fix #3 ---
  // Multi-hop cycle detection. Previously only the direct 1-cycle
  // (parent === child) was rejected; A→B + then `link-parent B A`
  // formed a 2-cycle (A→B→A) that formatTree would render as
  // "(circular reference)" forever and corrupted hub-spoke walks.
  it('rejects 2-hop cycle: existing A→B + proposed link-parent B A', async () => {
    const root = mkTmp();
    try {
      // Plant projection with A as root and B already pointing at A.
      plantProjection(root, [
        mkSession(SID_A),
        mkSession(SID_B, { parent_session_id: SID_A }),
      ]);
      // Now propose: A's parent = B → walks B's chain, finds A → cycle.
      const r = await runHandler(linkParentMod, [SID_A, SID_B, '--root', root]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /would create a cycle/);
      assert.match(r.stderr, new RegExp(`reaches child ${SID_A}`));
      // No event written.
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects 3-hop cycle: A→B→C, then link-parent A C', async () => {
    const root = mkTmp();
    const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';
    try {
      // Plant: C is root, B's parent = C, A's parent = B.
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B, { parent_session_id: SID_C }),
        mkSession(SID_C),
      ]);
      // Propose: C's parent = A → walks A→B→C, finds C at depth 2 → cycle.
      const r = await runHandler(linkParentMod, [SID_C, SID_A, '--root', root]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /would create a cycle/);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-cyclic re-parent across deep chain still succeeds', async () => {
    // Regression guard: cycle check must not over-trigger. A→B→C exists;
    // link-parent A C (re-parenting A from B to C) is fine — C's chain
    // is empty (no parent), so no cycle.
    const root = mkTmp();
    const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';
    try {
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B, { parent_session_id: SID_C }),
        mkSession(SID_C),
      ]);
      // Propose: A's parent = C. C has no parent_session_id → no cycle risk.
      const r = await runHandler(linkParentMod, [SID_A, SID_C, '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, SID_C);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cycle check is skipped when --remove (clearing parent cannot create a cycle)', async () => {
    // Regression guard: --remove must not invoke loadProjection-for-cycle
    // because there's no parent to walk. Plant a 2-hop chain and clear A.
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkSession(SID_A, { parent_session_id: SID_B }),
        mkSession(SID_B),
      ]);
      const r = await runHandler(linkParentMod, [SID_A, '--remove', '--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].parent_session_id, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------
describe('close handler', () => {
  it('sets outcome + closed_at + closed_reason', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(closeMod, [
        SID_A, '--outcome', 'done', '--reason', 'merged', '--root', root,
      ]);
      assert.equal(r.exitCode, 0, r.stderr);
      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A].outcome, 'done');
      assert.equal(proj.sessions[SID_A].closed_reason, 'merged');
      assert.ok(proj.sessions[SID_A].closed_at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid outcome', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(closeMod, [SID_A, '--outcome', 'bogus', '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /must be one of/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing --outcome', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(closeMod, [SID_A, '--root', root]);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /--outcome is required/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run does not write', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(closeMod, [
        SID_A, '--outcome', 'done', '--dry-run', '--root', root,
      ]);
      assert.equal(r.exitCode, 0);
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 1 on unknown stable_id', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkSession(SID_A)]);
      const r = await runHandler(closeMod, [
        'sess_no-such-id-zzzz-zzzz-zzzzzzzzzzzz', '--outcome', 'done', '--root', root,
      ]);
      assert.equal(r.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
