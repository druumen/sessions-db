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
import { existsSync } from 'node:fs';
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

  await t.test('tsc --noEmit accepts cockpit-style imports', (t) => {
    if (!existsSync(TSC_BIN)) {
      t.skip(
        `tsc not installed at ${TSC_BIN} — run \`npm install\` to enable types-smoke. ` +
          `Skipping (not a regression on fresh clones).`,
      );
      return;
    }
    const result = spawnSync(TSC_BIN, ['--noEmit', '-p', TSCONFIG], {
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
});
