import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isInjectedPrompt,
  listRolloutFiles,
  parseRollout,
  readFirstLine,
} from '../../lib/codex.mjs';

const SID = '01a07d1a-4180-7ab3-be8c-336dc7f2bab3';

function mkTmp(prefix = 'codex-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a rollout file in codex's YYYY/MM/DD layout. */
function plantRollout(root, { day = ['2026', '09', '07'], id = SID, meta = {}, records = [] } = {}) {
  const dir = join(root, ...day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-07T20-21-08-${id}.jsonl`);
  const lines = [JSON.stringify({
    timestamp: meta.timestamp ?? '2026-09-07T18:21:08.454Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-09-07T18:21:08.454Z',
      cwd: '/tmp/some-workspace',
      originator: 'Claude Code',
      cli_version: '0.153.4',
      thread_source: null,
      instructions: 'null',
      ...meta,
    },
  })];
  for (const r of records) lines.push(JSON.stringify(r));
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const userMsg = (text, ts) => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

describe('codex.mjs — readFirstLine', () => {
  it('reads a first line far larger than any fixed head window', () => {
    // The measured trap: `session_meta` carries the injected AGENTS.md in
    // `instructions` and routinely exceeds 4 KiB. A reader with a fixed window
    // truncates the line, JSON.parse throws, and EVERY file on the machine
    // looks like it has no metadata — 896 of 896, which is what the first
    // version of the corpus survey reported.
    const root = mkTmp();
    try {
      const huge = 'x'.repeat(300 * 1024);
      const path = plantRollout(root, { meta: { instructions: huge } });
      const line = readFirstLine(path);
      assert.ok(line.length > 300 * 1024, `first line came back truncated: ${line.length} bytes`);
      const rec = JSON.parse(line);
      assert.equal(rec.type, 'session_meta');
      assert.equal(rec.payload.instructions.length, huge.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a single-line file past the hard cap instead of reading it all', () => {
    const root = mkTmp();
    try {
      const path = join(root, 'one-line.jsonl');
      writeFileSync(path, 'y'.repeat(200 * 1024));
      assert.equal(readFirstLine(path, 64 * 1024), null);
      // Control: the same file under a cap that fits comes back whole, so the
      // null above is the cap and not an unreadable file.
      assert.equal(readFirstLine(path, 1024 * 1024).length, 200 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('codex.mjs — injected prompts', () => {
  it('recognises the wrappers the harness prepends', () => {
    for (const t of [
      '<recommended_plugins>\nHere is a list…',
      '<user_instructions>do the thing</user_instructions>',
      '<environment_context>cwd=/x</environment_context>',
      '# AGENTS.md instructions for /Users/x/project\n\n…',
    ]) {
      assert.equal(isInjectedPrompt(t), true, `should be injected: ${t.slice(0, 30)}`);
    }
  });

  it('keeps a real prompt that merely looks structured', () => {
    // Measured: real briefs in this corpus open with `<task>`, and one talks
    // ABOUT the injection. Anchoring at the start is what keeps both.
    for (const t of [
      '<task> Adversarial review of a TDD position statement…',
      '为什么 <recommended_plugins> 会出现在第一条消息里？',
      '根据CLAUDE.md进行codex初始化',
    ]) {
      assert.equal(isInjectedPrompt(t), false, `should NOT be injected: ${t.slice(0, 30)}`);
    }
  });
});

describe('codex.mjs — parseRollout', () => {
  it('extracts the session facts from session_meta', () => {
    const root = mkTmp();
    try {
      const path = plantRollout(root, { records: [userMsg('hello', '2026-09-07T18:22:00.000Z')] });
      const r = parseRollout(path);
      assert.equal(r.id, SID);
      assert.equal(r.cwd, '/tmp/some-workspace');
      assert.equal(r.originator, 'Claude Code');
      assert.equal(r.cliVersion, '0.153.4');
      assert.equal(r.startedAt, '2026-09-07T18:21:08.454Z');
      assert.equal(r.recordCount, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes lastActivityAt from the newest record IN THE FILE, never the clock', () => {
    const root = mkTmp();
    try {
      // `session_meta` is itself a record and carries the session START, so a
      // realistic fixture dates it BEFORE the body. (The first version of this
      // test left the default September meta on top of April messages and
      // failed — the fixture was wrong, not the parser, and a max over all
      // records is the behaviour we want.)
      const path = plantRollout(root, {
        meta: { timestamp: '2026-04-25T07:01:39.927Z' },
        records: [
          userMsg('one', '2026-04-25T07:09:47.902Z'),
          userMsg('two', '2026-04-25T07:25:51.050Z'),
        ],
      });
      const r = parseRollout(path);
      assert.equal(r.lastActivityAt, '2026-04-25T07:25:51.050Z');
      // A session from April must stay in April. Dating it to the ingest run
      // is the defect 0.4.0 shipped (median +50 days) and had to fix.
      assert.ok(r.lastActivityAt < new Date().toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the session start when the body carries no timestamps', () => {
    const root = mkTmp();
    try {
      const path = plantRollout(root, {
        meta: { timestamp: '2026-04-25T07:01:39.927Z' },
        records: [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'no ts' }] } }],
      });
      assert.equal(parseRollout(path).lastActivityAt, '2026-04-25T07:01:39.927Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips injected openers and takes the first REAL prompt', () => {
    const root = mkTmp();
    try {
      const path = plantRollout(root, {
        records: [
          userMsg('<recommended_plugins>\nplugins…', '2026-09-07T18:21:10.000Z'),
          userMsg('# AGENTS.md instructions for /x\n\nrules…', '2026-09-07T18:21:11.000Z'),
          userMsg('真正的第一句话', '2026-09-07T18:21:12.000Z'),
          userMsg('第二句', '2026-09-07T18:21:13.000Z'),
        ],
      });
      assert.equal(parseRollout(path).firstPrompt, '真正的第一句话');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when the head is not session_meta — unreadable, not empty', () => {
    const root = mkTmp();
    try {
      const dir = join(root, '2026', '09', '07');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-09-07T20-21-08-${SID}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: 'event_msg', payload: {} }) + '\n');
      assert.equal(parseRollout(path), null);
      // Control: the same directory with a well-formed file does parse, so the
      // null above is this file and not the fixture layout.
      assert.notEqual(parseRollout(plantRollout(root)), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('codex.mjs — listRolloutFiles', () => {
  it('finds rollouts in the YYYY/MM/DD tree and ignores everything else', () => {
    const root = mkTmp();
    try {
      plantRollout(root, { day: ['2026', '09', '07'], id: SID });
      plantRollout(root, { day: ['2026', '04', '25'], id: '01a00000-0000-7000-8000-000000000001' });
      // Neighbours that must not be picked up.
      writeFileSync(join(root, 'notes.jsonl'), '{}\n');
      mkdirSync(join(root, '2026', '09', '07', 'nested'), { recursive: true });
      writeFileSync(join(root, '2026', '09', '07', 'nested', 'rollout-x.jsonl'), '{}\n');
      writeFileSync(join(root, '2026', '09', '07', 'other.jsonl'), '{}\n');

      const files = listRolloutFiles(root);
      assert.equal(files.length, 2, files.join('\n'));
      assert.ok(files.every((f) => f.includes('rollout-')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing root rather than throwing', () => {
    assert.deepEqual(listRolloutFiles('/tmp/sdb-no-such-codex-root-xyz'), []);
  });
});
