/**
 * End-to-end packaged-consumer smoke test.
 *
 * The cjs-smoke + types-smoke tests both BYPASS the package.json exports
 * map (cjs-smoke require()s lib/index.cjs by absolute path; types-smoke
 * uses tsconfig `paths` alias to types/index.d.ts directly). That means
 * a regression in the exports map structure (Bug A class — string-form
 * entry, missing `types` condition, wrong condition order) would NOT be
 * caught.
 *
 * This test does the canonical end-to-end thing:
 *   1. `npm pack` the current source → produces a .tgz tarball
 *   2. Create a temp consumer dir with a minimal package.json
 *   3. `npm install <tarball>` into the temp dir
 *   4. From the temp dir, exercise BOTH:
 *      - CJS: `require('@druumen/sessions-db')` → assert documented surface
 *      - ESM: `import('@druumen/sessions-db')` → assert documented surface
 *      - Types: write a .ts file + run `tsc --noEmit` with Node16
 *        moduleResolution → assert TypeScript can resolve types and
 *        values through the actual exports map
 *
 * If any of these fail, the publish would ship a broken package even
 * if cjs-smoke + types-smoke pass.
 *
 * Cost: ~5-10s per test run (npm pack is fast; npm install of a single
 * zero-runtime-dep tarball is fast). Acceptable for the CI gate.
 *
 * Skip path: if `tsc` is not installed (fresh clone without `npm
 * install`), the types portion skips. The CJS+ESM portions still run.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');

function runHere(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 60_000,
    ...opts,
  });
}

test('pack-install-smoke', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'sessions-db-pack-smoke-'));
  let tarballPath = null;

  // Pack first so the consumer dir can install from it. Note: npm pack
  // does NOT trigger prepublishOnly, so the build must already be fresh
  // when running this test (CI runs `npm run build` before tests).
  await t.test('npm pack produces a tarball', () => {
    const packResult = runHere(
      'npm',
      ['pack', '--pack-destination', tmp, '--silent'],
      { cwd: PACKAGE_ROOT },
    );
    assert.equal(
      packResult.status,
      0,
      `npm pack failed:\nstdout: ${packResult.stdout}\nstderr: ${packResult.stderr}`,
    );
    const files = readdirSync(tmp).filter((f) => f.endsWith('.tgz'));
    assert.equal(files.length, 1, `expected 1 tarball, got ${files.length}`);
    tarballPath = join(tmp, files[0]);
  });

  await t.test('npm install + CJS require resolves through exports map', () => {
    if (!tarballPath) return;
    const consumerDir = join(tmp, 'cjs-consumer');
    spawnSync('mkdir', ['-p', consumerDir]);
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'cjs-consumer', version: '0.0.0', private: true }),
    );

    const installResult = runHere('npm', ['install', tarballPath, '--silent'], {
      cwd: consumerDir,
    });
    assert.equal(
      installResult.status,
      0,
      `npm install failed:\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`,
    );

    // CJS require — exercises exports[".".require].
    const cjsScript = `
      const sd = require('@druumen/sessions-db');
      const expected = ['loadProjection','setAlias','setParent','closeSession','initProjection','watchProjection','runSweep'];
      const missing = expected.filter(fn => typeof sd[fn] !== 'function');
      if (missing.length > 0) {
        process.stderr.write('CJS require missing: ' + missing.join(',') + '\\n');
        process.exit(1);
      }
      process.stdout.write('CJS require OK: ' + expected.length + ' fns resolved through exports map\\n');
    `;
    const cjsResult = runHere(process.execPath, ['-e', cjsScript], {
      cwd: consumerDir,
    });
    assert.equal(
      cjsResult.status,
      0,
      `CJS require via exports map failed:\nstdout: ${cjsResult.stdout}\nstderr: ${cjsResult.stderr}`,
    );
  });

  await t.test('ESM dynamic import resolves through exports map', () => {
    if (!tarballPath) return;
    const consumerDir = join(tmp, 'esm-consumer');
    spawnSync('mkdir', ['-p', consumerDir]);
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify({
        name: 'esm-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
      }),
    );

    const installResult = runHere('npm', ['install', tarballPath, '--silent'], {
      cwd: consumerDir,
    });
    assert.equal(
      installResult.status,
      0,
      `npm install (esm consumer) failed:\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`,
    );

    // ESM import — exercises exports[".".import].
    const esmScript = `
      const sd = await import('@druumen/sessions-db');
      const expected = ['loadProjection','setAlias','setParent','closeSession','initProjection','watchProjection','runSweep'];
      const missing = expected.filter(fn => typeof sd[fn] !== 'function');
      if (missing.length > 0) {
        process.stderr.write('ESM import missing: ' + missing.join(',') + '\\n');
        process.exit(1);
      }
      process.stdout.write('ESM import OK: ' + expected.length + ' fns resolved through exports map\\n');
    `;
    writeFileSync(join(consumerDir, 'smoke.mjs'), esmScript);
    const esmResult = runHere(process.execPath, ['smoke.mjs'], {
      cwd: consumerDir,
    });
    assert.equal(
      esmResult.status,
      0,
      `ESM import via exports map failed:\nstdout: ${esmResult.stdout}\nstderr: ${esmResult.stderr}`,
    );
  });

  await t.test(
    'TypeScript Node16 resolves both types AND values through exports map',
    (t) => {
      if (!tarballPath) return;

      const tscBin = resolve(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc');
      if (!existsSync(tscBin)) {
        t.skip(`tsc not installed at ${tscBin} — skipping`);
        return;
      }

      const consumerDir = join(tmp, 'ts-consumer');
      spawnSync('mkdir', ['-p', consumerDir]);
      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({
          name: 'ts-consumer',
          version: '0.0.0',
          private: true,
          devDependencies: { typescript: 'latest' },
        }),
      );

      // Install tarball + symlink tsc from the package's own node_modules
      // (saves a separate tsc install). Then write a Node16 tsconfig that
      // does NO `paths` alias — full reliance on the exports map.
      const installResult = runHere(
        'npm',
        ['install', tarballPath, '--silent'],
        { cwd: consumerDir },
      );
      assert.equal(
        installResult.status,
        0,
        `npm install (ts consumer) failed:\nstderr: ${installResult.stderr}`,
      );

      writeFileSync(
        join(consumerDir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'Node16',
              moduleResolution: 'Node16',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              esModuleInterop: true,
            },
            include: ['./consumer.ts'],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(consumerDir, 'consumer.ts'),
        `// Both type and value imports through the exports map.
import {
  loadProjection,
  setAlias,
  type KnownSession,
  type Projection,
} from '@druumen/sessions-db';

void loadProjection;
void setAlias;
const _x: KnownSession | null = null;
const _y: Projection | null = null;
void _x; void _y;
`,
      );

      const tscResult = runHere(tscBin, ['--noEmit'], { cwd: consumerDir });
      assert.equal(
        tscResult.status,
        0,
        `tsc against installed tarball failed:\n--- stdout ---\n${tscResult.stdout}\n--- stderr ---\n${tscResult.stderr}`,
      );
    },
  );

  rmSync(tmp, { recursive: true, force: true });
});
