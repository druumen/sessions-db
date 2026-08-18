import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pendingDir,
  pendingPath,
  writePending,
  readPending,
  deletePending,
  listPending,
  sweepPending,
  markPromoterAlive,
  isPromoterAlive,
  PENDING_DIRNAME,
  PENDING_MAX_AGE_MS,
  PROMOTER_MARKER,
  PROMOTER_MAX_AGE_MS,
  PROMOTER_BACKLOG_MIN_AGE_MS,
  PROMOTER_BACKLOG_MIN_COUNT,
} from '../../lib/pending.mjs';

function mkTmp(prefix = 'pending-test-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// claude_session_id is a raw UUID (distinct from the `sess_<uuidv7>` shape
// of stable_id) — that's what SessionStart hands us on stdin.
const CSID_A = '11111111-aaaa-bbbb-cccc-111111111111';
const CSID_B = '22222222-aaaa-bbbb-cccc-222222222222';
const CSID_C = '33333333-aaaa-bbbb-cccc-333333333333';

function mkRecord(csid, overrides = {}) {
  return {
    claude_session_id: csid,
    observed_at: new Date().toISOString(),
    cwd: '/fake/project',
    branch_at_start: 'main',
    head_at_start: 'a'.repeat(40),
    worktree_path_observed: '/fake/project',
    worktree_realpath: '/fake/project',
    worktree_registry_name: null,
    git_common_dir: '/fake/project/.git',
    source: 'startup',
    ...overrides,
  };
}

describe('pending.mjs', () => {
  describe('round-trip', () => {
    it('writePending -> readPending returns the record; file lands at pendingPath; schema:1 on disk', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        const record = mkRecord(CSID_A);
        assert.equal(writePending(record, opts), true);

        const path = pendingPath(CSID_A, opts);
        assert.equal(path, join(pendingDir(opts), `${CSID_A}.json`));
        assert.equal(existsSync(path), true);

        const back = readPending(CSID_A, opts);
        assert.equal(back.claude_session_id, CSID_A);
        assert.equal(back.cwd, record.cwd);
        assert.equal(back.branch_at_start, record.branch_at_start);
        assert.equal(back.schema, 1);

        // schema:1 must be present in the actual bytes on disk, not just in
        // whatever readPending happens to hand back.
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(raw.schema, 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('overwrite-on-repeat', () => {
    it('writing twice for the same csid keeps exactly one file with the latest content', () => {
      // SessionStart can fire twice ~30ms apart for the same session (warm
      // pool + IDE panel both mint a hook call) — the second write must win
      // in place, not accumulate a sibling file.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A, { cwd: '/first' }), opts), true);
        assert.equal(writePending(mkRecord(CSID_A, { cwd: '/second' }), opts), true);

        assert.equal(listPending(opts).length, 1);
        const record = readPending(CSID_A, opts);
        assert.equal(record.cwd, '/second');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('readPending guards', () => {
    it('returns null when no file exists', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(readPending(CSID_A, opts), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null for malformed JSON', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        mkdirSync(pendingDir(opts), { recursive: true });
        writeFileSync(pendingPath(CSID_A, opts), '{ not valid json ');
        assert.equal(readPending(CSID_A, opts), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when the stored claude_session_id does not match the requested one', () => {
      // Guards against trusting a renamed/corrupted file: the FILENAME
      // (derived from the requested id) is not proof of what is inside —
      // readPending cross-checks the payload's own claude_session_id field.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true);
        // Overwrite the bytes in place: filename still says CSID_A, but the
        // stored record now claims to be CSID_B.
        writeFileSync(pendingPath(CSID_A, opts), JSON.stringify(mkRecord(CSID_B)));
        assert.equal(readPending(CSID_A, opts), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('path-traversal gate (invariant-false side)', () => {
    // isUuidLike is a security gate, not a politeness check: claude_session_id
    // ultimately comes from hook stdin (untrusted input) and gets joined into
    // a filesystem path. Anything that is not a canonical UUID must be
    // rejected BEFORE it reaches path.join, so '../../etc/passwd' can never
    // escape the pending directory.
    const MALICIOUS_IDS = ['../../etc/passwd', 'not-a-uuid', '', null];

    it('pendingPath returns null for every non-UUID id', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        for (const id of MALICIOUS_IDS) {
          assert.equal(pendingPath(id, opts), null,
            `pendingPath(${JSON.stringify(id)}) should be null`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writePending returns false for every non-UUID id and creates no file at all', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        for (const id of MALICIOUS_IDS) {
          const ok = writePending(mkRecord(id), opts);
          assert.equal(ok, false, `writePending(${JSON.stringify(id)}) should return false`);
        }
        // pendingPath() returning null means writePending bails out BEFORE
        // mkdirSync runs — a purely-malicious sequence must never even
        // create the pending directory, let alone a file inside or outside it.
        assert.equal(existsSync(pendingDir(opts)), false,
          'no pending directory should exist after only-malicious writes');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('malicious ids cannot smuggle a file into an already-existing pending dir', () => {
      // Create the dir for real first (one legit session), THEN attempt the
      // malicious writes — proves the guard holds even once mkdirSync has
      // already run and could otherwise happily create further nested paths.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true);
        for (const id of MALICIOUS_IDS) {
          assert.equal(writePending(mkRecord(id), opts), false);
        }
        const entries = readdirSync(pendingDir(opts));
        assert.deepEqual(entries, [`${CSID_A}.json`],
          'pending dir must contain only the one legitimate record');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('deletePending', () => {
    it('is idempotent: second call returns false and does not throw', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true);
        assert.equal(deletePending(CSID_A, opts), true);
        assert.equal(existsSync(pendingPath(CSID_A, opts)), false);

        // Second delete on an already-gone file must not throw ENOENT — the
        // promoter and sweepPending race on the same file with no locking,
        // so "already deleted" is an expected outcome, not exceptional.
        const second = deletePending(CSID_A, opts);
        assert.equal(second, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns false for a claude_session_id that was never written', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(deletePending(CSID_A, opts), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('listPending', () => {
    it('returns {claude_session_id, path, mtimeMs} for legit records and ignores debris', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true);
        assert.equal(writePending(mkRecord(CSID_B), opts), true);

        // Debris a naive "push every readdirSync entry" implementation would
        // wrongly surface: a non-.json sibling, and a .json file whose
        // basename is not UUID-shaped (foreign tool, or a half-renamed file).
        writeFileSync(join(pendingDir(opts), 'notes.txt'), 'not a pending record');
        writeFileSync(join(pendingDir(opts), 'debris.json'), '{}');

        const entries = listPending(opts);
        assert.equal(entries.length, 2);
        const byId = Object.fromEntries(entries.map((e) => [e.claude_session_id, e]));
        assert.ok(byId[CSID_A]);
        assert.ok(byId[CSID_B]);
        for (const e of entries) {
          assert.equal(e.path, pendingPath(e.claude_session_id, opts));
          assert.equal(typeof e.mtimeMs, 'number');
          assert.ok(e.mtimeMs > 0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns [] for a pending dir that does not exist, without throwing', () => {
      const dir = mkTmp();
      const opts = { rootPath: join(dir, 'never-created') };
      try {
        assert.deepEqual(listPending(opts), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('sweepPending', () => {
    it('removes entries older than maxAgeMs and keeps the rest, returning {removed, kept}', () => {
      // Floor to the second so the utimesSync offsets below land on whole
      // seconds regardless of the host filesystem's mtime resolution —
      // avoids any theoretical sub-second-precision flakiness.
      const now = Math.floor(Date.now() / 1000) * 1000;
      const maxAgeMs = 24 * 60 * 60 * 1000;
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true); // aged out below
        assert.equal(writePending(mkRecord(CSID_B), opts), true); // stays fresh
        assert.equal(writePending(mkRecord(CSID_C), opts), true); // stays fresh

        const oldSec = (now - maxAgeMs - 60_000) / 1000; // well past the threshold
        utimesSync(pendingPath(CSID_A, opts), oldSec, oldSec);
        // B and C keep the fresh mtime writePending just gave them.

        const result = sweepPending(opts, { now, maxAgeMs });
        assert.deepEqual(result, { removed: 1, kept: 2 });
        assert.equal(listPending(opts).length, 2);
        assert.equal(readPending(CSID_A, opts), null, 'aged-out record must be gone');
        assert.ok(readPending(CSID_B, opts), 'fresh record must survive');
        assert.ok(readPending(CSID_C, opts), 'fresh record must survive');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a file exactly at the max-age threshold is NOT removed (strict > comparison)', () => {
      // Invariant-false side of the boundary: sweepPending's condition is
      // `now - mtimeMs > maxAgeMs`, so age === maxAgeMs must survive and
      // only age > maxAgeMs gets reclaimed. A one-second gap between the two
      // fixtures keeps this robust across filesystem mtime granularities.
      const now = Math.floor(Date.now() / 1000) * 1000;
      const maxAgeMs = 60_000;
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true); // age === maxAgeMs
        assert.equal(writePending(mkRecord(CSID_B), opts), true); // age === maxAgeMs + 1s

        const atThresholdSec = (now - maxAgeMs) / 1000;
        const overThresholdSec = (now - maxAgeMs - 1000) / 1000;
        utimesSync(pendingPath(CSID_A, opts), atThresholdSec, atThresholdSec);
        utimesSync(pendingPath(CSID_B, opts), overThresholdSec, overThresholdSec);

        const result = sweepPending(opts, { now, maxAgeMs });
        assert.deepEqual(result, { removed: 1, kept: 1 });
        assert.ok(readPending(CSID_A, opts),
          'file at exactly the threshold must survive (invariant-false side)');
        assert.equal(readPending(CSID_B, opts), null,
          'file one second past the threshold must be removed');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to PENDING_MAX_AGE_MS when sweepOpts.maxAgeMs is omitted', () => {
      const now = Math.floor(Date.now() / 1000) * 1000;
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(writePending(mkRecord(CSID_A), opts), true);
        assert.equal(writePending(mkRecord(CSID_B), opts), true);

        // A is older than the 24h default; B is fresh. Only A should go.
        const staleSec = (now - PENDING_MAX_AGE_MS - 60_000) / 1000;
        utimesSync(pendingPath(CSID_A, opts), staleSec, staleSec);

        const result = sweepPending(opts, { now });
        assert.deepEqual(result, { removed: 1, kept: 1 });
        assert.equal(readPending(CSID_A, opts), null);
        assert.ok(readPending(CSID_B, opts));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns {removed:0, kept:0} for a non-existent pending dir, without throwing', () => {
      const dir = mkTmp();
      const opts = { rootPath: join(dir, 'never-created') };
      try {
        assert.deepEqual(sweepPending(opts, { now: Date.now() }), { removed: 0, kept: 0 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('exported constants', () => {
    it('PENDING_DIRNAME matches what pendingDir actually derives from rootPath', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(pendingDir(opts), join(dir, PENDING_DIRNAME));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Promoter liveness. Deferral is only sound if something will later promote
  // what was deferred, and the two hooks are registered independently in
  // settings.json. A machine with SessionStart but no UserPromptSubmit would
  // otherwise defer every new session into a void and record nothing at all —
  // silently, and strictly worse than the ghost records deferral prevents.
  // These tests pin the direction of the failure: unknown means "do not defer".
  // -------------------------------------------------------------------------

  describe('markPromoterAlive / isPromoterAlive', () => {
    it('a fresh storage root reports NO promoter (fail-safe default)', () => {
      const dir = mkTmp();
      try {
        assert.equal(isPromoterAlive({ rootPath: dir }), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('marking creates the marker and flips the answer', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        assert.equal(markPromoterAlive(opts), true);
        assert.equal(existsSync(join(pendingDir(opts), PROMOTER_MARKER)), true);
        assert.equal(isPromoterAlive(opts), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a marker older than the max age is NOT trusted', () => {
      // Invariant-false side: an expired marker must read as "no promoter" so
      // the hook falls back to recording eagerly rather than deferring blind.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        markPromoterAlive(opts);
        const marker = join(pendingDir(opts), PROMOTER_MARKER);
        const ancient = (Date.now() - PROMOTER_MAX_AGE_MS - 60_000) / 1000;
        utimesSync(marker, ancient, ancient);
        assert.equal(isPromoterAlive(opts), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a marker just inside the max age is still trusted', () => {
      // One second of margin rather than the exact boundary: filesystem mtime
      // granularity would otherwise make this a test of the filesystem's
      // rounding, not of the comparison. The expiry direction is pinned by the
      // "older than the max age" case above.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        markPromoterAlive(opts);
        const marker = join(pendingDir(opts), PROMOTER_MARKER);
        const now = Date.now();
        const justInside = (now - PROMOTER_MAX_AGE_MS + 1000) / 1000;
        utimesSync(marker, justInside, justInside);
        assert.equal(isPromoterAlive(opts, { now }), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('re-marking within the refresh window does not rewrite the file', () => {
      // The prompt hook calls this on EVERY user turn, so the steady-state cost
      // must be one stat, not one write. We detect the no-write by backdating
      // the mtime slightly and confirming it survives a second call.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        markPromoterAlive(opts);
        const marker = join(pendingDir(opts), PROMOTER_MARKER);
        const recent = (Date.now() - 60_000) / 1000; // 1 min ago, inside the 1 h window
        utimesSync(marker, recent, recent);
        const before = statSync(marker).mtimeMs;
        assert.equal(markPromoterAlive(opts), true);
        assert.equal(statSync(marker).mtimeMs, before,
          'a marker refreshed a minute ago must not be rewritten');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a marker older than the refresh window IS rewritten', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        markPromoterAlive(opts);
        const marker = join(pendingDir(opts), PROMOTER_MARKER);
        const stale = (Date.now() - 3 * 60 * 60 * 1000) / 1000; // 3 h ago
        utimesSync(marker, stale, stale);
        const before = statSync(marker).mtimeMs;
        assert.equal(markPromoterAlive(opts), true);
        assert.ok(statSync(marker).mtimeMs > before,
          'a stale marker must be refreshed so liveness does not lapse mid-use');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the marker is invisible to listPending (it is not a staged session)', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        markPromoterAlive(opts);
        writePending({ claude_session_id: CSID_A, observed_at: new Date().toISOString() }, opts);
        const listed = listPending(opts);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].claude_session_id, CSID_A);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Secondary liveness signal.
    //
    // The 30-day window answers "is the hook configured?" — but a user who
    // REMOVES the UserPromptSubmit registration while staying on 0.2.0 keeps a
    // marker that is fresh by that standard for a month, so SessionStart keeps
    // deferring into a void: every session staged, every staged record expired
    // at PENDING_MAX_AGE_MS, nothing recorded. That is the exact failure the
    // marker exists to prevent, with a 30-day blind window in front of it.
    //
    // The cross-check: a live promoter refreshes the marker hourly, so a stale
    // marker with sessions piling up BEHIND it is a backlog nobody is draining.
    // The tests below pin both directions, because the false-positive side
    // matters too — a healthy machine's warm-pool ghosts are unpromoted
    // stagings in normal operation and must not trip it.
    // -----------------------------------------------------------------------

    /** Stage `n` pending records and set each one's mtime to `ageMs` ago. */
    function stageAged(opts, n, ageMs, now = Date.now()) {
      for (let i = 0; i < n; i++) {
        const csid = `aaaaaaaa-0000-4000-8000-00000000000${i}`;
        writePending({ claude_session_id: csid, observed_at: new Date().toISOString() }, opts);
        const t = (now - ageMs) / 1000;
        utimesSync(join(pendingDir(opts), `${csid}.json`), t, t);
      }
    }

    /** Backdate the marker to `ageMs` ago. */
    function ageMarker(opts, ageMs, now = Date.now()) {
      const marker = join(pendingDir(opts), PROMOTER_MARKER);
      const t = (now - ageMs) / 1000;
      utimesSync(marker, t, t);
      return marker;
    }

    it('a stale marker alone is still trusted (staleness is not the signal)', () => {
      // Somebody who does not open this workspace for a day must not have
      // deferral switch off underneath them — that is the whole reason the
      // marker window is 30 days.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        ageMarker(opts, 8 * 60 * 60 * 1000, now);
        assert.equal(isPromoterAlive(opts, { now }), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a stale marker plus an unpromoted backlog is NOT trusted, and retires the marker', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        const marker = ageMarker(opts, 8 * 60 * 60 * 1000, now);
        // Staged after the marker went quiet, and old enough that a live
        // promoter would have drained them.
        stageAged(opts, PROMOTER_BACKLOG_MIN_COUNT, 2 * 60 * 60 * 1000, now);

        assert.equal(isPromoterAlive(opts, { now }), false);
        // Retired rather than merely ignored: the evidence (the backlog) is
        // itself GC'd at PENDING_MAX_AGE_MS, so leaving the marker in place
        // would make the answer flip back to "alive" a day later and start
        // losing sessions again on a machine that never fixed anything.
        assert.equal(existsSync(marker), false, 'the discredited marker must be retired');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the retirement is self-healing: one real promoter run restores trust', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        ageMarker(opts, 8 * 60 * 60 * 1000, now);
        stageAged(opts, PROMOTER_BACKLOG_MIN_COUNT, 2 * 60 * 60 * 1000, now);
        assert.equal(isPromoterAlive(opts, { now }), false);

        // The prompt hook running once — i.e. the user re-registered it.
        assert.equal(markPromoterAlive(opts), true);
        assert.equal(isPromoterAlive(opts), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('ghosts staged BEFORE the marker do not discredit it', () => {
      // False-positive guard. Warm-pool spawns are staged and never promoted
      // in normal operation, so their existence proves nothing; what would
      // prove something is that they accumulated while no promoter ran.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        stageAged(opts, PROMOTER_BACKLOG_MIN_COUNT + 2, 20 * 60 * 60 * 1000, now);
        ageMarker(opts, 8 * 60 * 60 * 1000, now);
        assert.equal(isPromoterAlive(opts, { now }), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a backlog younger than the grace period does not discredit the marker', () => {
      // A record staged minutes ago may be promoted the second the user types.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        ageMarker(opts, 8 * 60 * 60 * 1000, now);
        stageAged(opts, PROMOTER_BACKLOG_MIN_COUNT + 2, PROMOTER_BACKLOG_MIN_AGE_MS / 2, now);
        assert.equal(isPromoterAlive(opts, { now }), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fewer staged records than the threshold does not discredit the marker', () => {
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        ageMarker(opts, 8 * 60 * 60 * 1000, now);
        stageAged(opts, PROMOTER_BACKLOG_MIN_COUNT - 1, 2 * 60 * 60 * 1000, now);
        assert.equal(isPromoterAlive(opts, { now }), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a fresh marker is trusted no matter how large the backlog is', () => {
      // The steady state, and the fast path: a promoter that ran within the
      // hour is alive by direct evidence, so the backlog is not even read.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      const now = Date.now();
      try {
        markPromoterAlive(opts);
        stageAged(opts, PROMOTER_BACKLOG_MIN_COUNT + 5, 5 * 60 * 60 * 1000, now);
        assert.equal(isPromoterAlive(opts, { now }), true);
        assert.equal(existsSync(join(pendingDir(opts), PROMOTER_MARKER)), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('sweepPending never deletes the marker, however old it is', () => {
      // The marker records a configuration fact, not activity. GC'ing it would
      // silently switch deferral off on a machine that is correctly configured.
      const dir = mkTmp();
      const opts = { rootPath: dir };
      try {
        markPromoterAlive(opts);
        const marker = join(pendingDir(opts), PROMOTER_MARKER);
        const ancient = (Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(marker, ancient, ancient);
        sweepPending(opts, { maxAgeMs: 1 });
        assert.equal(existsSync(marker), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
