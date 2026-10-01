/** Reproducible synthetic-only benchmark: node __tests__/benchmarks/content-search.mjs */
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanTranscriptContent } from '../../lib/search-cache.mjs';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--worker') {
  const [root, mode, query] = process.argv.slice(3);
  let sourceOpens = 0;
  const snippets = [];
  const begin = performance.now();
  for (const f of readdirSync(join(root, 'data')).sort()) {
    snippets.push(await scanTranscriptContent(join(root, 'data', f), query, {
      cacheDir: mode === 'off' ? undefined : join(root, 'cache'),
      openStream: (p, opts) => { sourceOpens++; return createReadStream(p, opts); },
    }));
  }
  process.stdout.write(JSON.stringify({ ms: performance.now() - begin,
    maxRssMiB: process.resourceUsage().maxRSS / 1024, sourceOpens,
    resultHash: createHash('sha256').update(JSON.stringify(snippets)).digest('hex') }));
} else {
  const root = mkdtempSync(join(tmpdir(), 'sessions-search-benchmark-'));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'home'));
  try {
    let sourceBytes = 0;
    const files = 64;
    const messages = 1000;
    for (let file = 0; file < files; file++) {
      const lines = [];
      for (let i = 0; i < messages; i++) {
        const text = `${i === 0 ? 'opening' : 'turn'} ${i}: 中文设计 arbitrary substring ${'context '.repeat(20)}${i === messages - 1 ? '尾部目标' : ''}`;
        const message = file % 2 ? { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } } :
          { type: 'assistant', message: { content: [{ type: 'text', text }] } };
        lines.push(JSON.stringify(message));
        // Non-searchable tool payloads represent verbose JSONL overhead.
        lines.push(JSON.stringify({ type: 'tool_result', result: 'synthetic-tool-output '.repeat(80) }));
      }
      const data = lines.join('\n') + '\n';
      sourceBytes += Buffer.byteLength(data);
      writeFileSync(join(root, 'data', `${file}.jsonl`), data);
    }
    const env = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'home', '.codex'),
      DRUUMEN_CLAUDE_PROJECTS_ROOT: join(root, 'home', '.claude', 'projects'),
      DRUUMEN_CODEX_SESSIONS_ROOT: join(root, 'home', '.codex', 'sessions'), DRUUMEN_SESSIONS_DB_ROOT: join(root, 'storage') };
    const results = [];
    for (const query of ['absent-query-xyz', 'opening', '尾部目标']) {
      const baseline = [];
      const cold = [];
      const warm = [];
      for (let repetition = 0; repetition < 5; repetition++) {
        const run = (mode) => JSON.parse(execFileSync(process.execPath, [self, '--worker', root, mode, query], { env, encoding: 'utf8' }));
        baseline.push(run('off'));
        rmSync(join(root, 'cache'), { recursive: true, force: true });
        cold.push(run('on'));
        warm.push(run('on'));
        if (baseline.at(-1).resultHash !== cold.at(-1).resultHash || baseline.at(-1).resultHash !== warm.at(-1).resultHash) throw Error('result mismatch');
      }
      const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const summarize = (samples) => ({ medianMs: +median(samples.map((r) => r.ms)).toFixed(1),
        peakRssMiB: +Math.max(...samples.map((r) => r.maxRssMiB)).toFixed(1),
        sourceOpens: samples[0].sourceOpens });
      const cacheBytes = readdirSync(join(root, 'cache')).filter((f) => f.endsWith('.bin'))
        .reduce((n, f) => n + statSync(join(root, 'cache', f)).size, 0);
      results.push({ query, off: summarize(baseline), cold: summarize(cold), warm: summarize(warm), cacheMiB: +(cacheBytes / 1024 ** 2).toFixed(2) });
    }
    process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      files, messagesPerFile: messages, sourceMiB: +(sourceBytes / 1024 ** 2).toFixed(2), repetitions: 5, results }, null, 2) + '\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
