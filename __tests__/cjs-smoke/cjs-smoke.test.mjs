/**
 * CJS-consumer smoke test — Bug C regression guard.
 *
 * 0.1.0 shipped as pure ESM (`"type": "module"` + only `.mjs` source).
 * Cockpit (Node16 CJS context) hit `TS1479: ECMAScript module cannot
 * be imported with require` at B1. 0.1.1 ships dual CJS+ESM build
 * (`lib/index.cjs` bundled by esbuild from `lib/index.mjs`).
 *
 * This test spawns a child Node process in CJS mode and verifies that
 * `require('@druumen/sessions-db')` (resolved through the local
 * `lib/index.cjs` directly, since we are not actually published) yields
 * a value bag with the documented public surface.
 *
 * Why a child process: the test runner itself is ESM (`.mjs`), so we
 * can't `require()` from the test file directly. A subprocess CJS
 * script proves a real CJS consumer would succeed.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const CJS_BUNDLE = resolve(PACKAGE_ROOT, 'lib', 'index.cjs');

test('cjs-smoke', async (t) => {
  await t.test('lib/index.cjs exists (build:cjs has run)', () => {
    assert.ok(
      existsSync(CJS_BUNDLE),
      `expected CJS bundle at ${CJS_BUNDLE} — run 'npm run build:cjs' first.`,
    );
  });

  await t.test('require() exposes documented public functions + constants', () => {
    if (!existsSync(CJS_BUNDLE)) {
      // Already failed above; skip cascade.
      return;
    }
    const script = `
      const sd = require(${JSON.stringify(CJS_BUNDLE)});
      const fns = [
        // Storage primitives
        'loadProjection','rebuildProjection','recordSessionSeen',
        'tryUpdateProjection','newEvent','appendEvent','readAllEvents',
        'saveProjection',
        // Operations
        'setAlias','linkTask','unlinkTask','setParent','closeSession','runSweep',
        // Lifecycle
        'initProjection','watchProjection',
        // Paths
        'resolveStoragePaths','pathsFromRoot',
        // Identity
        'resolveIdentity','findByClaudeSessionId','findByTranscriptLineage',
        'scanFingerprintCandidates','collectParentCandidates','capParentCandidates',
        'classifyCorroborators','meetsThreshold',
        // Sweep planner
        'computeSweepTransitions','computeEffectiveLastProgress',
        // Sanitize
        'sanitizeFirstPrompt','stripIdeWrappers','stripSystemReminders',
        // UUIDv7
        'generateSessionId','isSessionId','extractTimestamp',
        // Projection reducers
        'applyEvent','emptyProjection','emptySession','rebuildFromEvents',
      ];
      const consts = [
        'PATHS','MAX_EVENT_BYTES','STORAGE_FILENAMES','MAX_ASCEND_DEPTH',
        'MAX_PARENT_CANDIDATES','STRONG_CORROBORATORS','WEAK_CORROBORATORS',
      ];
      const missing = [];
      for (const fn of fns) {
        if (typeof sd[fn] !== 'function') {
          missing.push('fn:' + fn + ' (got ' + typeof sd[fn] + ')');
        }
      }
      for (const c of consts) {
        if (sd[c] === undefined) {
          missing.push('const:' + c);
        }
      }
      if (missing.length > 0) {
        process.stderr.write(JSON.stringify({ missing }) + '\\n');
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ fnCount: fns.length, constCount: consts.length }) + '\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(
      result.status,
      0,
      `child process exited ${result.status}\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}\n`,
    );
    const out = JSON.parse(result.stdout.trim());
    assert.ok(out.fnCount >= 35, `expected ≥35 functions, got ${out.fnCount}`);
    assert.ok(out.constCount >= 7, `expected ≥7 constants, got ${out.constCount}`);
  });

  await t.test('CJS bundle does not reference ESM-only globals at top level', () => {
    // esbuild --format=cjs should rewrite ESM features. Quick sanity:
    // bundle should not contain a literal `import.meta` (would crash
    // CJS consumers immediately on require).
    if (!existsSync(CJS_BUNDLE)) return;
    const content = readFileSync(CJS_BUNDLE, 'utf8');
    assert.ok(
      !content.includes('import.meta'),
      'CJS bundle should not contain literal import.meta — esbuild conversion broke',
    );
  });
});
