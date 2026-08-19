/**
 * Types-smoke runner — wraps `tsc --noEmit` on the cockpit-import smoke
 * fixture so the existing `npm test` flow exercises the public type
 * surface alongside the runtime tests.
 *
 * Why a wrapper instead of authoring assertions in JS:
 *   - The JS test runner can't verify TypeScript shape contracts. The
 *     authoritative check is `tsc --noEmit`. This file just spawns it
 *     and asserts exit-zero.
 *   - tsc is available because Day 2 installed it as a devDependency
 *     (lives at `packages/sessions-db/node_modules/.bin/tsc` after
 *     `npm install`).
 *
 * Skip behaviour:
 *   - When `tsc` cannot be located (e.g. consumer ran the test glob
 *     without first running `npm install`), we `t.skip(...)` rather
 *     than fail. This keeps the test from appearing as a regression
 *     in fresh-clone CI runs that have not yet installed devDeps.
 *   - When the `__tests__/types-smoke/cockpit-import.ts` fixture is
 *     absent (e.g. someone deletes it), we surface a hard failure —
 *     a missing smoke fixture is a real regression.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
// On Windows, npm-installed binaries are `.cmd` shim wrappers, not bare
// executables. `node_modules/.bin/tsc` exists on POSIX; `node_modules/.bin/tsc.cmd`
// exists on Windows. Pick the right one so spawnSync can find it.
const TSC_BIN = process.platform === 'win32'
  ? resolve(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc.cmd')
  : resolve(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc');
const TSCONFIG = resolve(HERE, 'tsconfig.json');
const FIXTURE = resolve(HERE, 'cockpit-import.ts');
// The CJS half. `package.json` hands a require() consumer a DIFFERENT types
// file (`types/index.d.cts`), maintained by hand because tsc only emits
// `.d.mts` from `lib/`. Nothing compiled it until this pair existed, and it
// had drifted: the whole name-model type block was missing from it.
const TSCONFIG_CJS = resolve(HERE, 'tsconfig.cjs.json');
const FIXTURE_CJS = resolve(HERE, 'cockpit-require.cts');

const TYPES_ESM = resolve(PACKAGE_ROOT, 'types', 'index.d.ts');
const TYPES_CJS = resolve(PACKAGE_ROOT, 'types', 'index.d.cts');

/**
 * The identifiers in a barrel's `export type { ... } from ...` block.
 * Comment lines and the module specifier are ignored; what is compared is the
 * set of names a consumer can import.
 */
function exportedTypeNames(path) {
  const src = readFileSync(path, 'utf8');
  const block = src.match(/export type \{([\s\S]*?)\} from/);
  if (!block) throw new Error(`no \`export type { ... } from\` block in ${path}`);
  return block[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
}

/** Run tsc against one project; returns the spawn result or null when tsc is absent. */
function runTsc(project) {
  if (!existsSync(TSC_BIN)) return null;
  return spawnSync(TSC_BIN, ['--noEmit', '-p', project], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    // tsc can take a few seconds in cold-cache scenarios; give it 30s.
    timeout: 30_000,
    // On Windows, `tsc.cmd` is a batch shim; Node's spawnSync invoking
    // a .cmd directly fails with EINVAL. `shell: true` routes through
    // cmd.exe so the batch script can execute its node-runner internals.
    // POSIX is unaffected (its `tsc` is a normal executable script).
    shell: process.platform === 'win32',
  });
}

test('types-smoke', async (t) => {
  await t.test('cockpit-import.ts fixture exists', () => {
    assert.ok(
      existsSync(FIXTURE),
      `expected smoke fixture at ${FIXTURE} — missing fixtures are a regression`,
    );
  });

  await t.test('tsconfig.json exists alongside fixture', () => {
    assert.ok(
      existsSync(TSCONFIG),
      `expected tsconfig at ${TSCONFIG} — missing config is a regression`,
    );
  });

  await t.test('CJS fixture and tsconfig exist', () => {
    assert.ok(existsSync(FIXTURE_CJS), `expected CJS smoke fixture at ${FIXTURE_CJS}`);
    assert.ok(existsSync(TSCONFIG_CJS), `expected CJS tsconfig at ${TSCONFIG_CJS}`);
  });

  await t.test('tsc --noEmit accepts cockpit-style imports', (t) => {
    const result = runTsc(TSCONFIG);
    if (!result) {
      t.skip(
        `tsc not installed at ${TSC_BIN} — run \`npm install\` to enable types-smoke. ` +
          `Skipping (not a regression on fresh clones).`,
      );
      return;
    }
    if (result.error) {
      assert.fail(`tsc spawn failed: ${result.error.message}`);
    }
    assert.equal(
      result.status,
      0,
      `tsc exited with ${result.status}\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}\n`,
    );
  });

  await t.test('tsc --noEmit accepts a require()-condition consumer', (t) => {
    // The `require` condition resolves `types/index.d.cts`, a hand-maintained
    // file tsc never emits. Before this test, a type name added to
    // `index.d.ts` and forgotten here failed at the consumer's install and
    // nowhere earlier.
    const result = runTsc(TSCONFIG_CJS);
    if (!result) {
      t.skip(`tsc not installed at ${TSC_BIN} — skipping CJS types-smoke.`);
      return;
    }
    if (result.error) {
      assert.fail(`tsc spawn failed: ${result.error.message}`);
    }
    assert.equal(
      result.status,
      0,
      `tsc exited with ${result.status}\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}\n`,
    );
  });

  await t.test('the two barrels export the same type names', () => {
    // `index.d.cts` claims in its own header to be identical to
    // `index.d.ts` bar the extension. This is the mechanism behind the
    // claim. The compile checks above only catch a missing name once a
    // fixture references it; this catches it the moment the lists diverge,
    // which is the failure mode that actually happened.
    assert.deepEqual(
      exportedTypeNames(TYPES_CJS),
      exportedTypeNames(TYPES_ESM),
      'types/index.d.cts and types/index.d.ts must export the same type names',
    );
  });
});
