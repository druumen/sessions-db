/** Disposable, bounded transcript text cache. The transcript remains authoritative. */
import {
  createReadStream, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { deserialize, serialize } from 'node:v8';
import { acquireLock } from './lock.mjs';
import { extractSnippet, recordText } from './search.mjs';

const VERSION = 2; // v2 verifies source bytes; bump when extraction semantics change.
const DEFAULT_LIMITS = { entryBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, entries: 1024 };
const ENTRY_NAME = /^[a-f0-9]{64}\.bin$/;
const TEMP_NAME = /^[a-f0-9]{64}\.bin\.tmp\.[a-f0-9-]+$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest();
// CLI invocations normally have one directory. Retain no corpus text in memory.
const budgets = new Map();
function generationFor(dir) {
  try {
    const file = join(dir, '.generation');
    if (statSync(file).size > 128) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

function budgetFor(dir) {
  const stamp = generationFor(dir);
  const known = budgets.get(dir);
  if (known?.stamp === stamp) return known;
  const budget = { stamp, entries: new Map(), total: 0 };
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (TEMP_NAME.test(name)) { unlinkSync(p); continue; }
    if (!ENTRY_NAME.test(name)) continue;
    const s = statSync(p);
    budget.entries.set(p, { size: s.size, time: s.mtimeMs });
    budget.total += s.size;
  }
  if (budgets.size >= 4) budgets.delete(budgets.keys().next().value);
  budgets.set(dir, budget);
  return budget;
}

function fingerprint(path) {
  try {
    const s = statSync(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  } catch { return null; }
}

function readEntry(file, path, stamp, limits) {
  try {
    if (statSync(file).size > limits.entryBytes) return null;
    const bytes = readFileSync(file);
    if (bytes.length < 33 || bytes.length > limits.entryBytes) return null;
    const payload = bytes.subarray(32);
    if (!digest(payload).equals(bytes.subarray(0, 32))) return null;
    const e = deserialize(payload);
    if (e?.version !== VERSION || e.path !== path || e.stamp !== stamp ||
        !Number.isSafeInteger(e.sourceBytes) || e.sourceBytes < 0 ||
        typeof e.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(e.sourceHash) ||
        typeof e.complete !== 'boolean' || !Array.isArray(e.texts) ||
        !e.texts.every((t) => typeof t === 'string' && t.length > 0)) return null;
    return e;
  } catch { return null; }
}

async function saveEntry(dir, file, entry, limits) {
  let lock;
  let temp;
  try {
    const payload = serialize(entry);
    const bytes = Buffer.concat([digest(payload), payload]);
    if (bytes.length > limits.entryBytes || bytes.length > limits.totalBytes || limits.entries < 1) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Busy/stale locks only skip cache population; never delay a search.
    lock = await acquireLock(join(dir, '.write.lock'), { timeoutMs: 0 });
    // A lock serializes writers; generations detect other cooperating writers.
    // Own writes update this snapshot, so cold construction isn't O(files²).
    const budget = budgetFor(dir);
    const previous = budget.entries.get(file);
    if (previous) { budget.total -= previous.size; budget.entries.delete(file); }
    while (budget.entries.size && (budget.total + bytes.length > limits.totalBytes || budget.entries.size >= limits.entries)) {
      let oldestPath;
      let oldest;
      for (const [p, e] of budget.entries) {
        if (!oldest || e.time < oldest.time) { oldestPath = p; oldest = e; }
      }
      unlinkSync(oldestPath);
      budget.entries.delete(oldestPath);
      budget.total -= oldest.size;
    }
    temp = `${file}.tmp.${randomUUID()}`;
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
    temp = null;
    budget.entries.set(file, { size: bytes.length, time: Date.now() });
    budget.total += bytes.length;
    budget.stamp = randomUUID();
    writeFileSync(join(dir, '.generation'), budget.stamp, { mode: 0o600 });
  } catch {
    budgets.delete(dir);
    // The result has already been obtained from the source. Cache IO is optional.
  } finally {
    if (temp) { try { unlinkSync(temp); } catch {} }
    lock?.release();
  }
}

/** Original line-by-line scan, retaining early exit and malformed-line tolerance.
 * Collection also stops at the first hit. A prefix cache cannot prove absence.
 * openStream is an internal test seam; production always uses createReadStream.
 */
function scanSource(path, query, { collect = false, entryBytes, openStream = createReadStream } = {}) {
  return new Promise((resolveScan) => {
    let done = false;
    let texts = collect ? [] : null;
    let textBytes = 4096;
    let sourceBytes = 0;
    const sourceHash = collect ? createHash('sha256') : null;
    const stream = openStream(path, {});
    // Hash the exact binary chunks before readline decodes those same chunks.
    // A prefix includes the whole chunk containing its first hit, including any
    // read-ahead within that chunk. Never reread different bytes to stamp text.
    stream.on('data', (chunk) => {
      if (done || !sourceHash) return;
      sourceHash.update(chunk);
      sourceBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const finish = (snippet, complete) => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      resolveScan({ snippet, texts, complete, sourceBytes, sourceHash: sourceHash?.digest('hex') });
    };
    rl.on('line', (line) => {
      if (done || !line) return;
      let record;
      try { record = JSON.parse(line); } catch { return; }
      const text = recordText(record);
      if (text && texts) {
        // Upper bound on serialized strings: two bytes/code unit + framing.
        textBytes += text.length * 2 + 16;
        if (textBytes > entryBytes) texts = null;
        else texts.push(text);
      }
      const snippet = extractSnippet(text, query);
      if (snippet) finish(snippet, false);
    });
    stream.on('error', () => { texts = null; finish(null, false); });
    rl.on('error', () => { texts = null; finish(null, false); });
    rl.on('close', () => finish(null, true));
  });
}

async function sourceMatches(path, entry, openStream = createReadStream) {
  let stream;
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    // Complete entries verify the entire source, including malformed/non-message
    // records. Prefix entries need only verify the exact bytes already scanned.
    const opts = !entry.complete && entry.sourceBytes > 0 ? { end: entry.sourceBytes - 1 } : {};
    stream = openStream(path, opts);
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    }
    return bytes === entry.sourceBytes && hash.digest('hex') === entry.sourceHash;
  } catch { return false; }
  finally { stream?.destroy(); }
}

/** Search ordered message strings, never concatenating across message boundaries.
 * No cache directory (or DRUUMEN_SESSIONS_DB_SEARCH_CACHE=0 in the CLI) gives
 * the original scanner, useful for diagnosis and differential validation.
 */
export async function scanTranscriptContent(path, query, { cacheDir, limits: overrides, openStream } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const absolutePath = resolve(path);
  const stamp = cacheDir ? fingerprint(absolutePath) : null;
  const file = cacheDir && join(cacheDir, `${digest(absolutePath).toString('hex')}.bin`);
  const entry = stamp && readEntry(file, absolutePath, stamp, limits);
  if (entry) {
    let snippet = null;
    for (const text of entry.texts) {
      snippet = extractSnippet(text, query);
      if (snippet) break;
    }
    if ((snippet || entry.complete) && await sourceMatches(absolutePath, entry, openStream) &&
        fingerprint(absolutePath) === stamp) {
      try { const now = new Date(); utimesSync(file, now, now); } catch {}
      const cachedBudget = budgets.get(cacheDir);
      const cachedEntry = cachedBudget?.entries.get(file);
      if (cachedEntry) cachedEntry.time = Date.now();
      return snippet;
    }
  }
  const result = await scanSource(path, query, { collect: !!stamp, entryBytes: limits.entryBytes, openStream });
  if (stamp && result.texts && fingerprint(absolutePath) === stamp) {
    await saveEntry(cacheDir, file, {
      version: VERSION, path: absolutePath, stamp, texts: result.texts, complete: result.complete,
      sourceBytes: result.sourceBytes, sourceHash: result.sourceHash,
    }, limits);
  }
  return result.snippet;
}
