import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { searchByMetadata, discoverTranscriptPaths, makeDiskCache } from '../../cli/search.mjs';
import { workspaceHashFromCwd } from '../../lib/transcript.mjs';

const SID_A = 'sess_aaaaaaaa-1111-7000-8000-000000000001';
const SID_B = 'sess_bbbbbbbb-2222-7000-8000-000000000002';
const SID_C = 'sess_cccccccc-3333-7000-8000-000000000003';

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
    cwd: null,
    first_prompt_preview: null,
    tasks: [],
    projects: [],
    claude_session_ids: [],
    transcript_files: [],
    ...overrides,
  };
}

function mkProjection(sessions) {
  const byId = {};
  for (const s of sessions) byId[s.stable_id] = s;
  return { _meta: { schema_version: 2 }, sessions: byId };
}

describe('search — searchByMetadata (pure)', () => {
  it('matches across alias / first_prompt and reports matched_in', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'Pricing Overhaul' }),
      mkSession(SID_B, { first_prompt_preview: 'fix the pricing bug' }),
      mkSession(SID_C, { alias: 'unrelated' }),
    ]);
    const r = searchByMetadata(proj, 'pricing');
    const ids = r.map((x) => x.session.stable_id).sort();
    assert.deepEqual(ids, [SID_A, SID_B].sort());
    const a = r.find((x) => x.session.stable_id === SID_A);
    assert.deepEqual(a.matched_in, ['alias']);
  });

  it('honors the state filter', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'pricing', activity_state: 'active' }),
      mkSession(SID_B, { alias: 'pricing', activity_state: 'archived' }),
    ]);
    const r = searchByMetadata(proj, 'pricing', { state: 'archived' });
    assert.equal(r.length, 1);
    assert.equal(r[0].session.stable_id, SID_B);
  });

  it('sorts by last_progress_at DESC', () => {
    const proj = mkProjection([
      mkSession(SID_A, { alias: 'x', last_progress_at: '2026-05-01T00:00:00.000Z' }),
      mkSession(SID_B, { alias: 'x', last_progress_at: '2026-05-20T00:00:00.000Z' }),
    ]);
    const r = searchByMetadata(proj, 'x');
    assert.deepEqual(
      r.map((x) => x.session.stable_id),
      [SID_B, SID_A],
    );
  });

  it('empty on no match', () => {
    const proj = mkProjection([mkSession(SID_A, { alias: 'foo' })]);
    assert.deepEqual(searchByMetadata(proj, 'zzz'), []);
  });
});

describe('search — discoverTranscriptPaths (disk fallback)', () => {
  let projectsRoot;
  let prevEnv;
  // cwd has an underscore on purpose — also exercises the hash fix.
  const CWD = '/tmp/fake_ws';
  const HASH = workspaceHashFromCwd(CWD); // -tmp-fake-ws

  before(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'cockpit-projects-'));
    prevEnv = process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
    process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = projectsRoot;
    const wsDir = join(projectsRoot, HASH);
    mkdirSync(wsDir, { recursive: true });
    // Two transcripts: one whose sessionId matches the session, one that doesn't.
    writeFileSync(
      join(wsDir, 'match.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'uuid-match', message: { content: 'hi' } }) + '\n',
    );
    writeFileSync(
      join(wsDir, 'other.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'uuid-other', message: { content: 'hi' } }) + '\n',
    );
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
    else process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = prevEnv;
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it('discovers the transcript whose sessionId matches claude_session_ids', async () => {
    const session = { cwd: CWD, claude_session_ids: ['uuid-match'], transcript_files: [] };
    const found = await discoverTranscriptPaths(session, makeDiskCache());
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith('match.jsonl'));
  });

  it('does not return transcripts whose sessionId is not in claude_session_ids', async () => {
    const session = { cwd: CWD, claude_session_ids: ['uuid-nope'], transcript_files: [] };
    assert.deepEqual(await discoverTranscriptPaths(session, makeDiskCache()), []);
  });

  it('returns [] when cwd is missing', async () => {
    const session = { cwd: null, claude_session_ids: ['uuid-match'], transcript_files: [] };
    assert.deepEqual(await discoverTranscriptPaths(session, makeDiskCache()), []);
  });

  it('returns [] when claude_session_ids is empty', async () => {
    const session = { cwd: CWD, claude_session_ids: [], transcript_files: [] };
    assert.deepEqual(await discoverTranscriptPaths(session, makeDiskCache()), []);
  });

  it('returns [] for a workspace dir that does not exist', async () => {
    const session = { cwd: '/tmp/no_such_ws_xyz', claude_session_ids: ['uuid-match'], transcript_files: [] };
    assert.deepEqual(await discoverTranscriptPaths(session, makeDiskCache()), []);
  });
});

/**
 * MR search. The number semantics are deliberately NOT substring — see the
 * comment in `matchSessionMetadata` — so both directions are pinned here.
 */
describe('search — merge request links', () => {
  const REPO = 'druumen/cn/drummen';
  const link = (n) => ({
    repository: REPO,
    number: n,
    url: `https://gitlab.tinfant.org/${REPO}/-/merge_requests/${n}`,
    first_seen_at: '2026-09-07T16:04:20.294Z',
  });
  const proj = () => mkProjection([
    mkSession(SID_A, { pr_links: [link(722)] }),
    mkSession(SID_B, { pr_links: [link(672), link(99)] }),
    mkSession(SID_C, { alias: 'no MRs here' }),
  ]);

  it('finds the session that opened an MR, by the forms a person types', () => {
    for (const q of ['722', '#722', '!722']) {
      const r = searchByMetadata(proj(), q);
      assert.deepEqual(r.map((x) => x.session.stable_id), [SID_A], `query ${q}`);
      assert.deepEqual(r[0].matched_in, ['pr']);
    }
  });

  it('does not widen a number query into a prefix match', () => {
    // `72` is a prefix of 722 and a substring of the url; neither may match.
    assert.deepEqual(searchByMetadata(proj(), '72').map((x) => x.session.stable_id), []);
    // Control: the sessions ARE findable, so the empty result above is the
    // rule at work rather than a broken fixture.
    assert.deepEqual(searchByMetadata(proj(), '99').map((x) => x.session.stable_id), [SID_B]);
  });

  it('matches the repository and the url by substring, and misses sessions with no links', () => {
    assert.deepEqual(
      searchByMetadata(proj(), 'druumen/cn').map((x) => x.session.stable_id).sort(),
      [SID_A, SID_B].sort(),
    );
    assert.deepEqual(searchByMetadata(proj(), 'gitlab.tinfant.org').map((x) => x.session.stable_id).sort(),
      [SID_A, SID_B].sort());
    assert.equal(searchByMetadata(proj(), 'druumen/cn').some((x) => x.session.stable_id === SID_C), false);
  });
});
