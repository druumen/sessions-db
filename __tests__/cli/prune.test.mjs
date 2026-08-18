import { describe, it, before, after } from 'node:test';
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

import * as pruneMod from '../../cli/prune.mjs';
import * as rebuildMod from '../../cli/rebuild.mjs';
import { emptySession } from '../../lib/projection.mjs';
import { assessScanTrust, DEFAULT_OLDER_THAN_MS } from '../../lib/prune.mjs';
import { loadProjection, newEvent } from '../../lib/storage.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'sessions-db.mjs');

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';

const MIN_MS = 60 * 1000;

// Comfortably past the default 1h floor (DEFAULT_OLDER_THAN_MS) so ghost
// records used across this file are unambiguous candidates without pinning
// the test to a literal "2 hours". Derived from the real constant so a
// future change to the default cannot silently make every "should be a
// candidate" test below start failing for an unrelated reason.
const GHOST_AGE_MS = DEFAULT_OLDER_THAN_MS * 2;

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-cli-prune-'));
}

function projectionPath(root) {
  return join(root, 'tickets/_logs/sessions-db.json');
}

/**
 * Plant a projection on disk. Mirrors the helper used by the sweep/rebuild
 * CLI tests (same `<root>/tickets/_logs/sessions-db.json` shape, same
 * `--root` anchoring) but with prune-specific session shapes (see mkGhost).
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

/**
 * Plant raw events.jsonl history directly (no projection cache file at
 * all). Mirrors the helper in rebuild.test.mjs — needed specifically for
 * the append-only replay test below, where the projection cache MUST be
 * absent so `rebuild` is forced to fold real events rather than reflect
 * whatever `plantProjection` injected straight into the cache.
 */
function plantEvents(root, events) {
  const dir = join(root, 'tickets/_logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sessions-db-events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function eventsLines(root) {
  const p = join(root, 'tickets/_logs/sessions-db-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Build a ghost-shaped session record: every prune criterion satisfied, so
 * this record IS a candidate under default flags unless a test overrides
 * exactly one field to prove that field alone spares it.
 *
 * Starts from the real `emptySession()` (lib/projection.mjs) rather than a
 * hand-duplicated object literal, so this helper tracks the projection
 * schema automatically — a field added there shows up here with its real
 * default instead of silently being absent from every test fixture.
 */
function mkGhost(stableId, overrides = {}) {
  const ts = isoAgo(GHOST_AGE_MS);
  return {
    ...emptySession(stableId, ts),
    // A real ghost fired SessionStart, which mints exactly one
    // claude_session_id — "ghost" means that id has no transcript on disk,
    // not that no id was ever assigned. An empty array would also read as
    // "no transcript" but would skip the disk-scan path entirely.
    claude_session_ids: [`csid-${stableId}`],
    ...overrides,
  };
}

/**
 * In-process handler runner — captures stdout/stderr/exitCode without
 * letting a handler's process.exit() kill the test process. Same
 * stub-process pattern used by the sweep/rebuild CLI tests.
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

// ---------------------------------------------------------------------------
// Hermetic transcript root — installed for the ENTIRE file (both in-process
// handler calls and spawned-CLI calls below).
//
// `runPrune` calls `indexTranscriptCsids()` (lib/transcript.mjs), which by
// default walks the real `~/.claude/projects/` tree. Left alone, "has a
// transcript on disk" would be decided by whatever the machine running this
// suite happens to have open in Claude Code right now — different on every
// laptop, different on CI, different five minutes from now. Pointing
// DRUUMEN_CLAUDE_PROJECTS_ROOT (re-read on every call — see
// claudeProjectsRoot() in lib/transcript.mjs) at a controlled tmpdir before
// ANY prune invocation makes "no transcript on disk" true by construction
// instead of true by accident. Two tests below deliberately swap this for the
// duration of a single call (a root that DOES hold the record's transcript;
// an empty / missing root) and restore it immediately after.
//
// The root holds one decoy transcript belonging to no fixture session. That
// is not decoration: since the scan-trust gate (lib/prune.mjs
// `assessScanTrust`), a scan that finds ZERO transcripts refuses to delete,
// because an empty scan cannot tell a ghost from a real session that was
// never resumed. A completely empty root would therefore make every --yes
// test in this file exercise the refusal instead of the prune. One unrelated
// file makes the scan trustworthy while leaving every fixture ghost exactly
// as transcript-less as before.
// ---------------------------------------------------------------------------
const DECOY_CSID = 'decoy-11111111-2222-3333-4444-555555555555';

let EMPTY_PROJECTS_ROOT;
let PREV_PROJECTS_ROOT_ENV;

before(() => {
  EMPTY_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), 'sessions-db-cli-prune-empty-projects-'));
  const decoyDir = join(EMPTY_PROJECTS_ROOT, '-Users-x-unrelated-workspace');
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(join(decoyDir, `${DECOY_CSID}.jsonl`), '{"type":"user"}\n');
  PREV_PROJECTS_ROOT_ENV = process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
  process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = EMPTY_PROJECTS_ROOT;
});

after(() => {
  if (PREV_PROJECTS_ROOT_ENV === undefined) delete process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
  else process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = PREV_PROJECTS_ROOT_ENV;
  rmSync(EMPTY_PROJECTS_ROOT, { recursive: true, force: true });
});

describe('prune handler — help', () => {
  it('--help prints usage and exits 0', async () => {
    const r = await runHandler(pruneMod, ['--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^Usage: sessions-db prune/);
    assert.match(r.stdout, /--yes/);
  });
});

// ---------------------------------------------------------------------------
// Safety posture: this is the only destructive command in the CLI, so the
// default is inverted relative to every other subcommand — no flags means
// report-only. --yes is required to actually delete, and the two flags that
// could contradict each other are rejected rather than guessed at.
// ---------------------------------------------------------------------------

describe('prune handler — dry-run-by-default safety posture', () => {
  it('no flags: reports the ghost, exits 0, writes nothing, changes nothing', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const beforeBytes = readFileSync(projectionPath(root), 'utf8');

      const r = await runHandler(pruneMod, ['--root', root]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /1 of 1 session would be removed/);
      assert.match(r.stdout, new RegExp(SID_A));
      assert.match(r.stdout, /Re-run with --yes/);

      // The whole point of the inverted default (see the "Safety posture"
      // docstring in cli/prune.mjs) is that no-flags must never delete.
      // events.jsonl must not even be created, and the projection file must
      // be byte-for-byte the same file we planted.
      assert.equal(eventsLines(root).length, 0);
      assert.equal(readFileSync(projectionPath(root), 'utf8'), beforeBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--yes prunes: ghost removed from the projection, exactly one session_prune event', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const r = await runHandler(pruneMod, ['--root', root, '--yes']);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /1 ghost record removed/);

      const proj = await loadProjection({ root });
      assert.equal(proj.sessions[SID_A], undefined);

      // Exactly one event, and it is the tombstone for THIS record — proves
      // prune does not also touch events.jsonl for anything else.
      const events = eventsLines(root);
      assert.equal(events.length, 1);
      assert.equal(events[0].op, 'session_prune');
      assert.equal(events[0].stable_id, SID_A);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--dry-run and --yes together: exit 2, mutually-exclusive error, no write', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const beforeBytes = readFileSync(projectionPath(root), 'utf8');

      // Guessing which of two contradictory flags the operator meant is
      // exactly the wrong instinct for a delete — cli/prune.mjs rejects
      // this combination as an argparse-level error instead.
      const r = await runHandler(pruneMod, ['--root', root, '--dry-run', '--yes']);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /mutually exclusive/);

      assert.equal(eventsLines(root).length, 0);
      assert.equal(readFileSync(projectionPath(root), 'utf8'), beforeBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scan trust — the second safety inversion.
//
// "No transcript on disk" is the ONLY criterion that separates a real session
// nobody ever resumed from a ghost: a record written by 0.1.7's SessionStart
// has no preview, no fingerprint and no ai_title either. So when the scan
// comes back empty, that criterion is satisfied by every record, and prune
// stops being "remove ghosts" and becomes "remove everything nobody resumed".
//
// Measured on a copy of the reference database (628 records): the real
// transcript root produced 151 candidates, an empty directory produced 192,
// and a non-existent directory also produced 192. The extra 41 in both broken
// cases were real sessions with real human questions in them. `sudo`, cron,
// containers and a typo'd DRUUMEN_CLAUDE_PROJECTS_ROOT all produce exactly
// that scan.
//
// The tests below run the invariant-false side deliberately: each one plants
// a record that IS a ghost by every other criterion, so if the gate is
// removed they go green by deleting it.
// ---------------------------------------------------------------------------

/** Point the transcript scan at `root` for the duration of one call. */
async function withProjectsRoot(root, fn) {
  process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = root;
  try {
    return await fn();
  } finally {
    process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = EMPTY_PROJECTS_ROOT;
  }
}

describe('prune handler — refuses to delete on an untrusted transcript scan', () => {
  it('--yes with a scan that found nothing: refuses, writes nothing, deletes nothing', async () => {
    const root = mkTmp();
    const noTranscripts = mkdtempSync(join(tmpdir(), 'sessions-db-prune-no-transcripts-'));
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const beforeBytes = readFileSync(projectionPath(root), 'utf8');

      const r = await withProjectsRoot(noTranscripts, () =>
        runHandler(pruneMod, ['--root', root, '--yes']));

      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /refusing to prune/);
      // The message has to be actionable: name the root that was scanned,
      // because every realistic cause (sudo, cron, container, typo'd env var)
      // is recognised the moment the operator reads which root it looked at.
      assert.ok(r.stderr.includes(noTranscripts), `stderr should name the scanned root: ${r.stderr}`);

      assert.equal(eventsLines(root).length, 0, 'refusal must not append a tombstone');
      assert.equal(readFileSync(projectionPath(root), 'utf8'), beforeBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(noTranscripts, { recursive: true, force: true });
    }
  });

  it('--yes with a scan that ERRORED (missing root): refuses too', async () => {
    // The ENOENT case is the one the old code walked straight past: the error
    // was recorded in scan.errors and no consumer ever read it. Both shapes
    // — silently empty and loudly failed — must reach the same refusal.
    const root = mkTmp();
    const missing = join(mkTmp(), 'does-not-exist');
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const r = await withProjectsRoot(missing, () =>
        runHandler(pruneMod, ['--root', root, '--json', '--yes']));

      assert.equal(r.exitCode, 1);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.refused, true);
      assert.equal(parsed.disk_scan.trusted, false);
      assert.ok(parsed.disk_scan.untrusted_reasons.includes('scan_errors'));
      assert.equal(eventsLines(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-run still reports, but flags the scan as untrusted', async () => {
    // Reporting is not destructive, so the dry run keeps working — but the
    // list it prints is meaningless, and saying so is the whole point.
    const root = mkTmp();
    const noTranscripts = mkdtempSync(join(tmpdir(), 'sessions-db-prune-no-transcripts-'));
    try {
      plantProjection(root, [mkGhost(SID_A)]);

      const asJson = await withProjectsRoot(noTranscripts, () =>
        runHandler(pruneMod, ['--root', root, '--json']));
      assert.equal(asJson.exitCode, 0, asJson.stderr);
      const parsed = JSON.parse(asJson.stdout);
      assert.equal(parsed.disk_scan.trusted, false);
      assert.deepEqual(parsed.disk_scan.untrusted_reasons, ['empty_scan']);
      assert.equal(parsed.disk_scan.root, noTranscripts);

      const asText = await withProjectsRoot(noTranscripts, () =>
        runHandler(pruneMod, ['--root', root]));
      assert.equal(asText.exitCode, 0, asText.stderr);
      assert.match(asText.stdout, /TRANSCRIPT SCAN NOT TRUSTWORTHY/);
      // Warning first, list second — a warning under a list of stable_ids is
      // a warning nobody reads.
      assert.ok(
        asText.stdout.indexOf('NOT TRUSTWORTHY') < asText.stdout.indexOf(SID_A),
        'the warning must precede the candidate list',
      );
      // And it must not close by recommending a command that will refuse.
      assert.doesNotMatch(asText.stdout, /Re-run with --yes to remove them/);
      assert.match(asText.stdout, /Fix the transcript scan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(noTranscripts, { recursive: true, force: true });
    }
  });

  it('--accept-untrusted-scan is the escape hatch: prunes anyway, still warns', async () => {
    // A machine really can have no transcripts (fresh container, transcripts
    // rotated away wholesale). The gate exists to make that an explicit
    // statement rather than an accident, not to make it impossible.
    const root = mkTmp();
    const noTranscripts = mkdtempSync(join(tmpdir(), 'sessions-db-prune-no-transcripts-'));
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const r = await withProjectsRoot(noTranscripts, () =>
        runHandler(pruneMod, ['--root', root, '--yes', '--accept-untrusted-scan']));

      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /TRANSCRIPT SCAN NOT TRUSTWORTHY/);
      assert.match(r.stdout, /1 ghost record removed/);
      const events = eventsLines(root);
      assert.equal(events.length, 1);
      assert.equal(events[0].op, 'session_prune');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(noTranscripts, { recursive: true, force: true });
    }
  });

  it('a trusted scan is not flagged (positive control)', async () => {
    // Without this, every assertion above would still pass if the gate were
    // wired to "always untrusted".
    const root = mkTmp();
    try {
      plantProjection(root, [mkGhost(SID_A)]);
      const r = await runHandler(pruneMod, ['--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.disk_scan.trusted, true);
      assert.deepEqual(parsed.disk_scan.untrusted_reasons, []);
      assert.equal(parsed.count, 1, 'the ghost is still a candidate under a trusted scan');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assessScanTrust (lib/prune.mjs)', () => {
  it('a scan with files and no errors is trusted', () => {
    assert.deepEqual(
      assessScanTrust({ dirCount: 3, fileCount: 12, errors: [], root: '/x' }),
      { trusted: true, reasons: [] },
    );
  });

  it('zero files is untrusted even when the scan reported no error', () => {
    // The nastier of the two failure modes: an existing but wrong directory
    // (sudo's /var/root/.claude/projects) reads cleanly and returns nothing.
    const t = assessScanTrust({ dirCount: 0, fileCount: 0, errors: [], root: '/x' });
    assert.equal(t.trusted, false);
    assert.deepEqual(t.reasons, ['empty_scan']);
  });

  it('any error is untrusted even when files were still found', () => {
    // A partial scan can drop exactly the directory holding the transcripts
    // of the records we are about to delete.
    const t = assessScanTrust({ dirCount: 3, fileCount: 12, errors: ['readdir(a): EACCES'] });
    assert.equal(t.trusted, false);
    assert.deepEqual(t.reasons, ['scan_errors']);
  });

  it('a malformed scan object is untrusted, not trusted-by-default', () => {
    for (const bad of [undefined, null, {}, { fileCount: 'lots' }]) {
      assert.equal(assessScanTrust(bad).trusted, false, `${JSON.stringify(bad)} must not be trusted`);
    }
  });
});

// ---------------------------------------------------------------------------
// --older-than: unit is required (this flag gates a delete, so an ambiguous
// bare number is rejected rather than defaulted), and the threshold is
// actually honored against created_at.
// ---------------------------------------------------------------------------

describe('prune handler — --older-than', () => {
  it('rejects a bare number with no unit', async () => {
    const root = mkTmp();
    try {
      // "24" is ambiguous — 24 what? sweep's --idle-threshold-days defaults
      // to days, prune defaults to hours. Guessing is the wrong trade for a
      // flag that gates a delete, so this must be rejected, not defaulted.
      const r = await runHandler(pruneMod, ['--root', root, '--older-than', '24']);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /expects a duration with a unit — 30m \/ 2h \/ 7d/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unparseable value', async () => {
    const root = mkTmp();
    try {
      const r = await runHandler(pruneMod, ['--root', root, '--older-than', 'abc']);
      assert.equal(r.exitCode, 2);
      assert.match(r.stderr, /expects a duration with a unit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors the threshold: a half-default-age ghost is spared by default, caught by --older-than 10m', async () => {
    const root = mkTmp();
    try {
      // Half of DEFAULT_OLDER_THAN_MS (30 minutes under the current 1h
      // default): old enough to be unambiguous, young enough that the
      // default floor must spare it. 10m is well under that either way, so
      // the override picks it up regardless of exactly where the default
      // sits.
      const recent = isoAgo(DEFAULT_OLDER_THAN_MS / 2);
      plantProjection(root, [mkGhost(SID_A, { created_at: recent, last_progress_at: recent })]);

      const withDefault = await runHandler(pruneMod, ['--root', root, '--json']);
      assert.equal(withDefault.exitCode, 0, withDefault.stderr);
      assert.equal(JSON.parse(withDefault.stdout).count, 0);

      const withOverride = await runHandler(
        pruneMod, ['--root', root, '--older-than', '10m', '--json'],
      );
      assert.equal(withOverride.exitCode, 0, withOverride.stderr);
      const parsed = JSON.parse(withOverride.stdout);
      assert.equal(parsed.count, 1);
      assert.equal(parsed.candidates[0].stable_id, SID_A);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --json output shape.
// ---------------------------------------------------------------------------

describe('prune handler — --json output shape', () => {
  it('dry-run JSON has the documented shape', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [
        mkGhost(SID_A),
        mkGhost(SID_B, { alias: 'keep me' }), // spared -> exercises a non-empty `spared` tally
      ]);
      const r = await runHandler(pruneMod, ['--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.dry_run, true);
      assert.equal(parsed.scanned, 2);
      assert.equal(parsed.count, parsed.candidates.length);
      assert.equal(parsed.count, 1);
      assert.equal(typeof parsed.spared, 'object');
      assert.equal(parsed.spared.has_alias, 1);
      assert.ok(parsed.disk_scan);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant-false side — the most important tests in this file. Prune's
// entire safety model (see the "judgement call" section of lib/prune.mjs) is
// that a record is a candidate ONLY when EVERY one of these signals is
// absent. Each test below builds a record that is ghost-shaped except for
// exactly one disqualifying attribute, and asserts prune leaves it alone —
// AND that it was spared for the specific reason under test, not by
// accident. If any one of these regresses, prune starts eating real session
// history instead of just stale placeholder rows.
// ---------------------------------------------------------------------------

/**
 * Assert that a single ghost-shaped record carrying `overrides` is NOT a
 * prune candidate, and (when given) that it was spared for `expectedReason`
 * specifically — not merely spared for some unrelated reason that would mask
 * a real bug in the criterion actually under test.
 */
async function assertSpared(overrides, expectedReason) {
  const root = mkTmp();
  try {
    plantProjection(root, [mkGhost(SID_A, overrides)]);
    const r = await runHandler(pruneMod, ['--root', root, '--json']);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(
      parsed.count, 0,
      `expected ${SID_A} to be spared; candidates: ${JSON.stringify(parsed.candidates)}`,
    );
    if (expectedReason) {
      assert.equal(
        parsed.spared[expectedReason], 1,
        `expected spared reason '${expectedReason}'; got: ${JSON.stringify(parsed.spared)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('prune handler — ghost criteria must ALL hold (invariant-false side)', () => {
  it('has first_prompt_preview -> spared (somebody typed)', async () => {
    await assertSpared({ first_prompt_preview: 'fix the pricing bug' }, 'has_first_prompt_preview');
  });

  it('has fingerprints.first_human_prompt_v1 -> spared (privacy opt-out guard)', async () => {
    // Users with the DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0 privacy opt-out have
    // first_prompt_preview: null on EVERY record they own, real or not — the
    // preview criterion alone cannot tell their real sessions from ghosts. A
    // non-null fingerprint is the thing that proves a transcript with real
    // content existed for this record; it is not stripped by that opt-out.
    // This is the criterion that makes prune safe to run at all for those
    // users.
    await assertSpared(
      { fingerprints: { first_human_prompt_v1: 'fp-abc123', lineage_prefix_v1: null } },
      'has_fingerprint',
    );
  });

  it('has fingerprints.lineage_prefix_v1 -> spared (same privacy-opt-out guard, other fingerprint)', async () => {
    await assertSpared(
      { fingerprints: { first_human_prompt_v1: null, lineage_prefix_v1: 'lp-xyz789' } },
      'has_fingerprint',
    );
  });

  it('has ai_title -> spared (Claude Code only emits ai-title once there is a conversation to title)', async () => {
    await assertSpared({ ai_title: 'Fix the pricing bug' }, 'has_ai_title');
  });

  it('has alias -> spared (a human deliberately labeled it)', async () => {
    await assertSpared({ alias: 'pricing-investigation' }, 'has_alias');
  });

  it('has parent_session_id -> spared (declared part of a lineage)', async () => {
    await assertSpared(
      { parent_session_id: 'sess_deadbeef-0000-7000-8000-000000000099' },
      'has_parent',
    );
  });

  it('has a non-empty tasks array -> spared', async () => {
    await assertSpared({ tasks: ['T-100'] }, 'has_task_or_project_link');
  });

  it('has a non-empty projects array -> spared', async () => {
    await assertSpared({ projects: ['P-100'] }, 'has_task_or_project_link');
  });

  it("has outcome other than 'open' -> spared (a closed session was deliberately closed)", async () => {
    await assertSpared({ outcome: 'done' }, 'has_outcome');
  });

  it('created_at too recent -> spared (never touch a session opened minutes ago)', async () => {
    await assertSpared(
      { created_at: isoAgo(5 * MIN_MS), last_progress_at: isoAgo(5 * MIN_MS) },
      'too_recent',
    );
  });

  it('is referenced as parent_session_id by another record -> spared (it is somebody\'s parent)', async () => {
    const root = mkTmp();
    try {
      // SID_B declares SID_A as its parent. SID_A is otherwise a perfect
      // ghost; deleting it would orphan SID_B's lineage link. "No operator
      // intent attached" (lib/prune.mjs criterion 6) explicitly covers being
      // someone ELSE's declared parent, not just declaring one of your own.
      plantProjection(root, [
        mkGhost(SID_A),
        mkGhost(SID_B, { parent_session_id: SID_A }),
      ]);
      const r = await runHandler(pruneMod, ['--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.candidates.some((c) => c.stable_id === SID_A), false);
      assert.equal(parsed.spared.is_parent_of_another, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('has a transcript on disk for its csid -> spared', async () => {
    const root = mkTmp();
    const projectsRootWithTranscript = mkdtempSync(
      join(tmpdir(), 'sessions-db-cli-prune-with-transcript-'),
    );
    const csid = 'csid-on-disk';
    try {
      // Any subdirectory name works here — indexTranscriptCsids() (see
      // lib/transcript.mjs) collects every <csid>.jsonl filename stem found
      // anywhere under the projects root; it does not try to match cwd to a
      // specific workspace-hash directory.
      const wsDir = join(projectsRootWithTranscript, 'some-workspace-hash');
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, `${csid}.jsonl`), '{"type":"user"}\n');

      plantProjection(root, [mkGhost(SID_A, { claude_session_ids: [csid] })]);

      // Swap in the root that actually has a transcript for the duration of
      // this one call only. Every other test in the file depends on
      // EMPTY_PROJECTS_ROOT staying empty for hermeticity, so it is restored
      // in `finally` before the next test runs.
      process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = projectsRootWithTranscript;
      const r = await runHandler(pruneMod, ['--root', root, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.candidates.some((c) => c.stable_id === SID_A), false);
      assert.equal(parsed.spared.transcript_on_disk, 1);
      // Confirms the scan actually ran against our planted file rather than
      // silently finding nothing and sparing it for some other reason.
      assert.equal(parsed.disk_scan.files, 1);
    } finally {
      process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = EMPTY_PROJECTS_ROOT;
      rmSync(root, { recursive: true, force: true });
      rmSync(projectsRootWithTranscript, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Append-only semantics: pruning writes a session_prune tombstone, it never
// rewrites events.jsonl. A full rebuild-from-events must reproduce the exact
// same pruned state, or the "append-only" claim in lib/prune.mjs's docstring
// would not actually hold.
// ---------------------------------------------------------------------------

describe('prune handler — append-only replay', () => {
  it('rebuild after --yes still lacks the pruned record', async () => {
    const root = mkTmp();
    try {
      // Unlike every other test in this file, this one must NOT use
      // plantProjection: that helper injects sessions straight into the
      // projection CACHE, but the cache is a derived view that `rebuild`
      // discards and recomputes purely from events.jsonl. A session that
      // exists only in the cache (never backed by an event) would vanish on
      // rebuild regardless of prune, which would make this test pass for
      // the wrong reason. session_seen is what a real hook run would have
      // written for each record before prune ever saw them.
      const ghostTs = isoAgo(GHOST_AGE_MS);
      plantEvents(root, [
        newEvent({
          op: 'session_seen',
          stable_id: SID_A,
          payload: { claude_session_id: `csid-${SID_A}`, created_at: ghostTs },
        }),
        newEvent({
          op: 'session_seen',
          stable_id: SID_B,
          payload: { claude_session_id: `csid-${SID_B}` },
        }),
        newEvent({
          op: 'alias_set',
          stable_id: SID_B,
          payload: { alias: 'keep me' },
        }),
      ]);

      const pruneResult = await runHandler(pruneMod, ['--root', root, '--yes']);
      assert.equal(pruneResult.exitCode, 0, pruneResult.stderr);

      const afterPrune = await loadProjection({ root });
      assert.equal(Object.keys(afterPrune.sessions).length, 1);
      assert.ok(afterPrune.sessions[SID_B]);

      // Replay the WHOLE log from scratch — this must land on the same
      // pruned state (SID_A gone, SID_B present), proving session_prune
      // really is a tombstone in the log rather than a one-off cache edit
      // that a rebuild would silently undo.
      const rebuildResult = await runHandler(rebuildMod, ['--root', root]);
      assert.equal(rebuildResult.exitCode, 0, rebuildResult.stderr);

      const afterRebuild = await loadProjection({ root });
      assert.equal(Object.keys(afterRebuild.sessions).length, 1);
      assert.equal(afterRebuild.sessions[SID_A], undefined);
      assert.ok(afterRebuild.sessions[SID_B]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI dispatcher integration — spawn the real CLI and verify end-to-end.
// ---------------------------------------------------------------------------

function runCLI(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd: opts.cwd || process.cwd(),
      // Spreads the current process.env, which by now carries the
      // DRUUMEN_CLAUDE_PROJECTS_ROOT override installed by the top-level
      // before() hook above — the spawned process inherits the same
      // hermetic transcript root as every in-process call in this file.
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

describe('prune handler — spawned CLI integration', () => {
  it('end-to-end: dry-run reports without writing, --yes prunes and writes one tombstone', async () => {
    const root = mkTmp();
    try {
      plantProjection(root, [mkGhost(SID_A)]);

      const dry = await runCLI(['prune', '--root', root]);
      assert.equal(dry.exitCode, 0, `dry stderr: ${dry.stderr}`);
      assert.match(dry.stdout, /would be removed/);
      assert.equal(eventsLines(root).length, 0);

      const real = await runCLI(['prune', '--root', root, '--yes']);
      assert.equal(real.exitCode, 0, `real stderr: ${real.stderr}`);
      assert.match(real.stdout, /1 ghost record removed/);

      const events = eventsLines(root);
      assert.equal(events.length, 1);
      assert.equal(events[0].op, 'session_prune');
      assert.equal(events[0].stable_id, SID_A);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--help works through the real dispatcher', async () => {
    const r = await runCLI(['prune', '--help']);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^Usage: sessions-db prune/);
  });
});
