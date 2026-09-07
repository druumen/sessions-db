import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHarvest } from '../../lib/harvest.mjs';
import { emptySession } from '../../lib/projection.mjs';

const CSID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const CSID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';

function mkTmp(prefix = 'sdb-harvest-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function plantProjection(root, sessions) {
  const dir = join(root, 'tickets/_logs');
  mkdirSync(dir, { recursive: true });
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  writeFileSync(join(dir, 'sessions-db.json'), JSON.stringify({
    _meta: { schema_version: 2, event_count: 0, last_event_id: null },
    sessions: byId,
  }));
}

const projectionOf = (root) =>
  JSON.parse(readFileSync(join(root, 'tickets/_logs/sessions-db.json'), 'utf8'));
const eventsPath = (root) => join(root, 'tickets/_logs/sessions-db-events.jsonl');

/** A transcript in a fake `~/.claude/projects/<dir>/<csid>.jsonl` layout. */
function plantTranscript(projectsRoot, csid, records) {
  const dir = join(projectsRoot, '-Users-someone-workspace');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${csid}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function session(stableId, csid, over = {}) {
  return { ...emptySession(stableId), claude_session_ids: [csid], ...over };
}

async function withProjectsRoot(root, fn) {
  const prev = process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
  process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
    else process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = prev;
  }
}

describe('harvest — backfill from transcripts on disk', () => {
  it('dry run reports what it would write and writes nothing; --yes writes it', async () => {
    const root = mkTmp();
    const projects = mkTmp('sdb-harvest-projects-');
    try {
      plantProjection(root, [session(SID_A, CSID_A)]);
      plantTranscript(projects, CSID_A, [
        { type: 'ai-title', aiTitle: 'a session nobody resumed', sessionId: CSID_A },
        { type: 'pr-link', sessionId: CSID_A, prNumber: 141, prRepository: 'druumen/cn/drummen',
          prUrl: 'https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/141',
          timestamp: '2026-06-01T00:00:00.000Z' },
      ]);

      const preview = await withProjectsRoot(projects, () => runHarvest({ root }));
      assert.equal(preview.dryRun, true);
      assert.equal(preview.changed, 1);
      assert.equal(preview.events, 2, 'one name + one link');
      assert.equal(existsSync(eventsPath(root)), false, 'a dry run must not create the log');
      assert.equal(projectionOf(root).sessions[SID_A].display_name, null);

      // The control: the same run with dryRun:false must actually land, so
      // the "wrote nothing" assertion above is the flag at work rather than a
      // harvest that never had anything to write.
      const real = await withProjectsRoot(projects, () => runHarvest({ root, dryRun: false }));
      assert.equal(real.events, 2);
      const s = projectionOf(root).sessions[SID_A];
      assert.equal(s.display_name, 'a session nobody resumed');
      assert.equal(s.display_name_channel, 'cc_ai_title');
      assert.deepEqual(s.pr_links.map((l) => l.number), [141]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('resolves the transcript by claude_session_id, not through transcript_files[]', async () => {
    const root = mkTmp();
    const projects = mkTmp('sdb-harvest-projects-');
    try {
      const otherPath = plantTranscript(projects, CSID_B, [
        { type: 'ai-title', aiTitle: 'SOMEBODY ELSE session', sessionId: CSID_B },
      ]);
      plantTranscript(projects, CSID_A, [
        { type: 'ai-title', aiTitle: 'the right one', sessionId: CSID_A },
      ]);
      // 70% of real `transcript_files[]` entries name a file that belongs to
      // no claude_session_id of their record. Harvesting through that array
      // would put the other session's name on this record.
      plantProjection(root, [session(SID_A, CSID_A, {
        transcript_files: [{ path: otherPath, first_seen_at: null, last_seen_at: null }],
      })]);

      await withProjectsRoot(projects, () => runHarvest({ root, dryRun: false }));
      assert.equal(projectionOf(root).sessions[SID_A].display_name, 'the right one');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('is a no-op for a session whose transcript is gone, and counts it as such', async () => {
    const root = mkTmp();
    const projects = mkTmp('sdb-harvest-projects-');
    try {
      plantProjection(root, [session(SID_A, CSID_A)]); // no transcript planted
      const r = await withProjectsRoot(projects, () => runHarvest({ root, dryRun: false }));
      assert.equal(r.withTranscript, 0);
      assert.equal(r.changed, 0);
      assert.equal(existsSync(eventsPath(root)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('--limit stops after n sessions that had a transcript', async () => {
    const root = mkTmp();
    const projects = mkTmp('sdb-harvest-projects-');
    try {
      plantProjection(root, [session(SID_A, CSID_A), session(SID_B, CSID_B)]);
      for (const [csid, title] of [[CSID_A, 'first'], [CSID_B, 'second']]) {
        plantTranscript(projects, csid, [{ type: 'ai-title', aiTitle: title, sessionId: csid }]);
      }
      const limited = await withProjectsRoot(projects, () => runHarvest({ root, limit: 1 }));
      assert.equal(limited.withTranscript, 1);
      // Control: without the limit the same fixture yields two.
      const all = await withProjectsRoot(projects, () => runHarvest({ root }));
      assert.equal(all.withTranscript, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('re-running after a real backfill writes nothing new', async () => {
    const root = mkTmp();
    const projects = mkTmp('sdb-harvest-projects-');
    try {
      plantProjection(root, [session(SID_A, CSID_A)]);
      plantTranscript(projects, CSID_A, [
        { type: 'ai-title', aiTitle: 'once is enough', sessionId: CSID_A },
      ]);
      await withProjectsRoot(projects, () => runHarvest({ root, dryRun: false }));
      const again = await withProjectsRoot(projects, () => runHarvest({ root, dryRun: false }));
      assert.equal(again.events, 0, 'the backfill is idempotent — cron-safe, re-run-safe');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });
});
