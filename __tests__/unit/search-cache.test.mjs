import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { scanTranscriptContent } from '../../lib/search-cache.mjs';
import { extractSnippet, recordText } from '../../lib/search.mjs';

const claude = (text) => JSON.stringify({ type: 'assistant', message: { content: text } });
const codex = (text) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role: 'user', content: [{ type: 'input_text', text }],
} });
const corpus = [claude('First MiXeD 中文测试 needle'), claude('ab'), codex('cd'),
  '{malformed', JSON.stringify({ type: 'tool_result', text: 'tool-secret' }),
  codex('Second needle and 尾部短词'), claude([{ text: 'block one' }, { text: 'block two' }])].join('\n') + '\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sessions-search-cache-'));
  const path = join(root, 'synthetic.jsonl');
  const cacheDir = join(root, 'cache');
  writeFileSync(path, corpus);
  return { root, path, cacheDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function oracle(path, query) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    try { const snippet = extractSnippet(recordText(JSON.parse(line)), query); if (snippet) return snippet; } catch {}
  }
  return null;
}
const cacheFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.bin'));
function decode(file) { return deserialize(readFileSync(file).subarray(32)); }
function encode(file, entry) {
  const payload = serialize(entry);
  writeFileSync(file, Buffer.concat([createHash('sha256').update(payload).digest(), payload]));
}

describe('derived content cache (synthetic transcripts only)', () => {
  it('matches uncached/cold/warm scans for both formats, Chinese, short substrings and message boundaries', async () => {
    const f = fixture();
    try {
      // A miss populates a complete cache; next queries must never open source.
      assert.equal(await scanTranscriptContent(f.path, 'absent', f), null);
      for (const q of ['NEEDLE', '中', '文测', 'eD 中', 'b', 'abcd', 'tool-secret', 'one block', '', '尾部']) {
        assert.equal(await scanTranscriptContent(f.path, q), oracle(f.path, q));
        assert.equal(await scanTranscriptContent(f.path, q, { ...f, openStream: () => { throw Error('warm source opened'); } }), oracle(f.path, q));
      }
      assert.equal(await scanTranscriptContent(f.path, 'abcd', f), null);
      assert.equal(decode(join(f.cacheDir, cacheFiles(f.cacheDir)[0])).complete, true);
    } finally { f.cleanup(); }
  });

  it('keeps cold early exit, reuses prefix hits, and scans source for prefix misses', async () => {
    const f = fixture();
    let suffixReads = 0;
    try {
      const first = claude('first hit') + '\n';
      writeFileSync(f.path, first + claude('later target') + '\n');
      const openStream = () => {
        let started = false;
        return new Readable({ read() {
          if (started) return;
          started = true;
          this.push(first);
          setTimeout(() => { if (!this.destroyed) { suffixReads++; this.push(claude('later target')); this.push(null); } }, 20);
        } });
      };
      assert.equal(await scanTranscriptContent(f.path, 'hit', { ...f, openStream }), 'first hit');
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(suffixReads, 0);
      const file = join(f.cacheDir, cacheFiles(f.cacheDir)[0]);
      assert.equal(decode(file).complete, false);
      assert.equal(await scanTranscriptContent(f.path, 'hit', { ...f, openStream: () => { throw Error('prefix source opened'); } }), 'first hit');
      let sourceReads = 0;
      const counted = (p, o) => { sourceReads++; return createReadStream(p, o); };
      assert.equal(await scanTranscriptContent(f.path, 'target', { ...f, openStream: counted }), 'later target');
      assert.equal(sourceReads, 1);
      assert.equal(await scanTranscriptContent(f.path, 'absent', { ...f, openStream: counted }), null);
      assert.equal(sourceReads, 2);
      assert.equal(decode(file).complete, true);
      assert.equal(await scanTranscriptContent(f.path, 'missing', { ...f, openStream: counted }), null);
      assert.equal(sourceReads, 2);
    } finally { f.cleanup(); }
  });

  for (const prefix of [false, true]) it(`invalidates ${prefix ? 'prefix' : 'complete'} caches on append, partial completion, truncate, same-size rewrite and inode replacement`, async () => {
    const f = fixture();
    try {
      for (const mutate of [
        () => appendFileSync(f.path, codex('appended 中文词') + '\n'),
        () => { appendFileSync(f.path, '{"type":"user","message":{"content":"half'); },
        () => appendFileSync(f.path, 'line target"}}\n'),
        () => writeFileSync(f.path, claude('truncated target') + '\n'),
        () => {
          const old = statSync(f.path);
          const oldNs = statSync(f.path, { bigint: true }).mtimeNs;
          writeFileSync(f.path, claude('rewritten target') + '\n');
          utimesSync(f.path, old.atime, old.mtime);
          assert.equal(statSync(f.path).size, old.size);
          assert.equal(statSync(f.path, { bigint: true }).mtimeNs, oldNs);
        },
        () => { const other = join(f.root, 'replacement'); writeFileSync(other, codex('new inode target') + '\n'); renameSync(other, f.path); },
      ]) {
        rmSync(f.cacheDir, { recursive: true, force: true });
        const fixedTime = new Date('2026-09-01T00:00:00Z');
        utimesSync(f.path, fixedTime, fixedTime);
        const firstText = recordText(JSON.parse(readFileSync(f.path, 'utf8').split('\n')[0]));
        await scanTranscriptContent(f.path, prefix ? firstText.slice(0, 3) : 'not-present', f);
        assert.equal(decode(join(f.cacheDir, cacheFiles(f.cacheDir)[0])).complete, !prefix);
        mutate();
        for (const q of ['target', '中文词', 'halfline', 'needle', 'missing']) {
          assert.equal(await scanTranscriptContent(f.path, q, f), oracle(f.path, q));
        }
      }
    } finally { f.cleanup(); }
  });

  it('falls back for corrupt, old-version, invalid-shaped, missing and unwritable caches', async () => {
    const f = fixture();
    try {
      await scanTranscriptContent(f.path, 'absent', f);
      const file = join(f.cacheDir, cacheFiles(f.cacheDir)[0]);
      const valid = decode(file);
      for (const damage of [
        () => writeFileSync(file, 'corrupted'),
        () => encode(file, { ...valid, version: 0 }),
        () => encode(file, { ...valid, texts: [null] }),
        () => { const bytes = readFileSync(file); bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes); },
        () => rmSync(file),
      ]) {
        damage();
        assert.equal(await scanTranscriptContent(f.path, 'needle', f), oracle(f.path, 'needle'));
      }
      const blocked = join(f.root, 'blocked');
      writeFileSync(blocked, 'not a directory');
      assert.equal(await scanTranscriptContent(f.path, 'needle', { cacheDir: blocked }), oracle(f.path, 'needle'));
      writeFileSync(join(f.cacheDir, '.write.lock'), 'busy');
      rmSync(file);
      assert.equal(await scanTranscriptContent(f.path, '尾部', f), oracle(f.path, '尾部'));
    } finally { f.cleanup(); }
  });

  it('bounds entry size, total bytes and entry count, and tolerates concurrent writers', async () => {
    const f = fixture();
    try {
      const opts = { cacheDir: f.cacheDir, limits: { entryBytes: 8192, totalBytes: 1200, entries: 2 } };
      const paths = Array.from({ length: 8 }, (_, i) => {
        const p = join(f.root, `${i}.jsonl`); writeFileSync(p, claude(`number ${i} ${'x'.repeat(120)}`) + '\n'); return p;
      });
      await Promise.all(paths.map((p) => scanTranscriptContent(p, 'absent', opts)));
      for (const p of paths) { assert.equal(await scanTranscriptContent(p, 'number', opts), oracle(p, 'number')); }
      const files = cacheFiles(f.cacheDir);
      assert.ok(files.length <= 2);
      assert.ok(files.reduce((n, file) => n + statSync(join(f.cacheDir, file)).size, 0) <= 1200);
      writeFileSync(f.path, claude('too-large ' + 'x'.repeat(9000)) + '\n');
      assert.equal(await scanTranscriptContent(f.path, 'too-large', opts), oracle(f.path, 'too-large'));
      assert.equal(cacheFiles(f.cacheDir).length, files.length);
      assert.equal(readdirSync(f.cacheDir).some((p) => p.includes('.tmp.')), false);
    } finally { f.cleanup(); }
  });

  it('does not reuse cache entries for a source that has disappeared', async () => {
    const f = fixture();
    try {
      await scanTranscriptContent(f.path, 'absent', f);
      rmSync(f.path);
      assert.equal(await scanTranscriptContent(f.path, 'needle', f), null);
    } finally { f.cleanup(); }
  });

  it('does not persist partial IO errors or a source changed during collection', async () => {
    const f = fixture();
    try {
      const failing = () => new Readable({ read() { this.destroy(Error('synthetic read failure')); } });
      assert.equal(await scanTranscriptContent(f.path, 'needle', { ...f, openStream: failing }), null);
      assert.equal(await scanTranscriptContent(f.path, 'needle', f), oracle(f.path, 'needle'));
      rmSync(f.cacheDir, { recursive: true, force: true });
      let started = false;
      const changing = () => new Readable({ read() {
        if (started) return;
        started = true;
        this.push(claude('old text') + '\n');
        appendFileSync(f.path, claude('newly appended target') + '\n');
        this.push(null);
      } });
      assert.equal(await scanTranscriptContent(f.path, 'target', { ...f, openStream: changing }), null);
      assert.equal(await scanTranscriptContent(f.path, 'target', f), 'newly appended target');
    } finally { f.cleanup(); }
  });
});
