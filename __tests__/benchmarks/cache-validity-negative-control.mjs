/** Verify each forced-fingerprint test carries its hash check, using code copies. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'sessions-db-cache-hash-control-'));
try {
  const controlHome = join(root, 'home');
  mkdirSync(controlHome);
  const env = { ...process.env, HOME: controlHome, CODEX_HOME: join(controlHome, '.codex'),
    DRUUMEN_CLAUDE_PROJECTS_ROOT: join(controlHome, '.claude', 'projects'),
    DRUUMEN_CODEX_SESSIONS_ROOT: join(controlHome, '.codex', 'sessions'),
    DRUUMEN_SESSIONS_DB_ROOT: join(root, 'storage') };
  for (const complete of [true, false]) {
    const copy = join(root, complete ? 'complete' : 'prefix');
    cpSync(join(repo, 'lib'), join(copy, 'lib'), { recursive: true });
    mkdirSync(join(copy, '__tests__', 'unit'), { recursive: true });
    const testFile = join(copy, '__tests__', 'unit', 'search-cache.test.mjs');
    const tests = readFileSync(join(repo, '__tests__', 'unit', 'search-cache.test.mjs'), 'utf8');
    writeFileSync(testFile, tests);
    const sourceFile = join(copy, 'lib', 'search-cache.mjs');
    const source = readFileSync(sourceFile, 'utf8');
    const target = "return bytes === entry.sourceBytes && hash.digest('hex') === entry.sourceHash;";
    assert.ok(source.includes(target));
    // Keep source IO and byte count checks, selectively bypass only the digest.
    writeFileSync(sourceFile, source.replace(target,
      `return bytes === entry.sourceBytes && (entry.complete === ${complete} || hash.digest('hex') === entry.sourceHash);`));
    const run = () => spawnSync(process.execPath, ['--test', testFile], { env, encoding: 'utf8' });
    const red = run();
    assert.notEqual(red.status, 0);
    assert.match(red.stdout, /^# fail 1$/m);
    assert.match(red.stdout, new RegExp(`not ok \\d+ - verifies middle bytes with a forced identical fingerprint \\(${complete ? 'complete' : 'prefix'}\\)`));
    writeFileSync(testFile, tests.replace('const complete of [true, false]', `const complete of [${!complete}]`));
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /^# fail 0$/m);
    const counts = (out) => out.split('\n').filter((line) => /^# (tests|pass|fail) /.test(line));
    process.stdout.write(JSON.stringify({ bypass: complete ? 'complete hash' : 'prefix hash', withBearingTest: counts(red.stdout), withoutBearingTest: counts(green.stdout) }) + '\n');
  }
} finally { rmSync(root, { recursive: true, force: true }); }
