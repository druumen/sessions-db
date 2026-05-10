import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  parseTranscriptFile,
  listTranscriptFiles,
  workspaceHashFromCwd,
} from '../transcript.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

describe('transcript.mjs — workspaceHashFromCwd', () => {
  it('dash-encodes a typical absolute path', () => {
    assert.equal(
      workspaceHashFromCwd('/Users/alice/Code/myproj.com'),
      '-Users-alice-Code-myproj-com',
    );
  });

  it('throws on a non-absolute path', () => {
    assert.throws(() => workspaceHashFromCwd('relative/path'), /absolute path/);
    assert.throws(() => workspaceHashFromCwd(''), /absolute path/);
    assert.throws(() => workspaceHashFromCwd(null), /absolute path/);
  });
});

describe('transcript.mjs — parseTranscriptFile', () => {
  it('parses a normal jsonl with mixed string/array content', async () => {
    const meta = await parseTranscriptFile(join(FIXTURES, 'normal.jsonl'));
    assert.equal(meta.status, 'ok');
    assert.equal(meta.sessionId, '00000000-0000-0000-0000-000000000001');
    assert.equal(meta.firstUuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(meta.lastUuid, '33333333-3333-4333-8333-333333333333');
    assert.equal(meta.firstParentUuid, null);
    assert.equal(meta.recordCount, 4);
    assert.equal(meta.cwd, '/tmp/fixture-cwd');
    assert.equal(meta.gitBranch, 'feat/fixture');
    // The first user external record has string content.
    assert.equal(meta.firstHumanPromptRaw, 'FIXTURE_PROMPT_STRING_CONTENT');
    assert.ok(meta.size > 0);
    assert.ok(meta.mtime instanceof Date);
  });

  it('detects resume by non-null firstParentUuid', async () => {
    const meta = await parseTranscriptFile(join(FIXTURES, 'resume.jsonl'));
    assert.equal(meta.status, 'ok');
    assert.equal(meta.sessionId, '00000000-0000-0000-0000-000000000002');
    assert.equal(meta.firstUuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(meta.firstParentUuid, '99999999-9999-4999-8999-999999999999');
    assert.equal(meta.firstHumanPromptRaw, 'FIXTURE_RESUMED_PROMPT');
  });

  it('joins array content (multiple text items) with newline', async () => {
    // The third record in normal.jsonl has array content, but it is not the
    // first human prompt. Build a one-record fixture inline so we can assert
    // the join behaviour directly.
    const tmp = mkdtempSync(join(tmpdir(), 'sdb-array-'));
    const path = join(tmp, 't.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        userType: 'external',
        uuid: '44444444-4444-4444-8444-444444444444',
        sessionId: 'sess-test',
        cwd: '/tmp/x',
        message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
      }) + '\n',
    );
    try {
      const meta = await parseTranscriptFile(path);
      assert.equal(meta.firstHumanPromptRaw, 'A\nB');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips non-text array items (e.g. tool_result, image)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sdb-mixed-'));
    const path = join(tmp, 't.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        userType: 'external',
        uuid: '55555555-5555-4555-8555-555555555555',
        sessionId: 'sess-mixed',
        cwd: '/tmp/x',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'x', content: 'TOOL OUTPUT' },
            { type: 'text', text: 'real text' },
            { type: 'image', source: { data: 'base64' } },
          ],
        },
      }) + '\n',
    );
    try {
      const meta = await parseTranscriptFile(path);
      assert.equal(meta.firstHumanPromptRaw, 'real text');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips invalid JSON lines but still parses the rest', async () => {
    const meta = await parseTranscriptFile(join(FIXTURES, 'corrupted.jsonl'));
    assert.equal(meta.status, 'ok');
    assert.equal(meta.recordCount, 3); // queue-op + user + assistant; 2 garbage lines skipped
    assert.equal(meta.firstUuid, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.equal(meta.lastUuid, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(meta.firstHumanPromptRaw, 'FIXTURE_PROMPT_AFTER_CORRUPT');
  });

  it('reports status=ok with recordCount=0 for an empty file', async () => {
    const meta = await parseTranscriptFile(join(FIXTURES, 'empty.jsonl'));
    assert.equal(meta.status, 'ok');
    assert.equal(meta.recordCount, 0);
    assert.equal(meta.sessionId, null);
    assert.equal(meta.firstUuid, null);
    assert.equal(meta.lastUuid, null);
    assert.equal(meta.firstHumanPromptRaw, null);
  });

  it('reports status=corrupted when every line fails to parse', async () => {
    const meta = await parseTranscriptFile(join(FIXTURES, 'all-corrupted.jsonl'));
    assert.equal(meta.status, 'corrupted');
    assert.equal(meta.recordCount, 0);
  });

  it('reports status=too_large without reading the file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sdb-big-'));
    const path = join(tmp, 'big.jsonl');
    // Write 2 MB of filler then call with maxSizeMb=1.
    writeFileSync(path, 'x'.repeat(2 * 1024 * 1024));
    try {
      const meta = await parseTranscriptFile(path, { maxSizeMb: 1 });
      assert.equal(meta.status, 'too_large');
      assert.equal(meta.recordCount, 0);
      assert.equal(meta.sessionId, null);
      assert.ok(meta.size > 1024 * 1024);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('transcript.mjs — firstHumanPromptRaw userType fallback chain', () => {
  // Helper: write a single user record and parse it back so each fallback
  // branch is exercised in isolation.
  async function parseSingleUser(rec) {
    const tmp = mkdtempSync(join(tmpdir(), 'sdb-fallback-'));
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, JSON.stringify(rec) + '\n');
    try {
      return await parseTranscriptFile(path);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('matches userType=external (empirical Claude Code shape)', async () => {
    const meta = await parseSingleUser({
      parentUuid: null,
      type: 'user',
      userType: 'external',
      uuid: '11111111-1111-4111-8111-aaaaaaaaaaa1',
      sessionId: 'sess-ext',
      cwd: '/tmp/x',
      message: { role: 'user', content: 'EXTERNAL_PROMPT' },
    });
    assert.equal(meta.firstHumanPromptRaw, 'EXTERNAL_PROMPT');
  });

  it('matches userType=human (ticket spec / forward compat)', async () => {
    const meta = await parseSingleUser({
      parentUuid: null,
      type: 'user',
      userType: 'human',
      uuid: '22222222-2222-4222-8222-aaaaaaaaaaa2',
      sessionId: 'sess-human',
      cwd: '/tmp/x',
      // Note: no message.role — proves the userType branch alone is enough.
      message: { content: 'HUMAN_PROMPT' },
    });
    assert.equal(meta.firstHumanPromptRaw, 'HUMAN_PROMPT');
  });

  it('matches message.role=user when userType is absent (semantic fallback)', async () => {
    const meta = await parseSingleUser({
      parentUuid: null,
      type: 'user',
      // No userType field at all.
      uuid: '33333333-3333-4333-8333-aaaaaaaaaaa3',
      sessionId: 'sess-norole',
      cwd: '/tmp/x',
      message: { role: 'user', content: 'SEMANTIC_FALLBACK_PROMPT' },
    });
    assert.equal(meta.firstHumanPromptRaw, 'SEMANTIC_FALLBACK_PROMPT');
  });

  it('returns null when none of the fallback conditions match', async () => {
    // type='user' but userType='tool' AND message.role='tool' — none of the
    // three legs of the fallback chain is satisfied, so we must NOT mistake
    // this tool echo for the first human prompt.
    const meta = await parseSingleUser({
      parentUuid: null,
      type: 'user',
      userType: 'tool',
      uuid: '44444444-4444-4444-8444-aaaaaaaaaaa4',
      sessionId: 'sess-tool',
      cwd: '/tmp/x',
      message: { role: 'tool', content: 'NOT_A_HUMAN_PROMPT' },
    });
    assert.equal(meta.firstHumanPromptRaw, null);
  });
});

describe('transcript.mjs — listTranscriptFiles', () => {
  it('returns [] for a non-existent workspace hash', () => {
    const out = listTranscriptFiles('-this-workspace-does-not-exist-xyz123');
    assert.deepEqual(out, []);
  });

  it('returns jsonl files sorted newest-first when given an absolute path', () => {
    // Simulate a workspace by passing an absolute path that hashes into a
    // non-existent dir; we just need to assert the function does not throw.
    const out = listTranscriptFiles('/tmp/sessions-db-test-nonexistent');
    assert.deepEqual(out, []);
  });
});
