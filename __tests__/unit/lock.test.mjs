import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { acquireLock } from '../lock.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOCK_MODULE = join(HERE, '..', 'lock.mjs');

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-lock-'));
}

describe('lock.mjs', () => {
  it('acquires and releases a lock', async () => {
    const dir = mkTmp();
    try {
      const lockPath = join(dir, 'a.lock');
      const handle = await acquireLock(lockPath, { timeoutMs: 500 });
      assert.equal(existsSync(lockPath), true, 'lock file exists while held');

      // Lock content should contain pid and an iso ts.
      const content = readFileSync(lockPath, 'utf8');
      assert.match(content, /^\d+\t\d{4}-\d{2}-\d{2}T/);

      handle.release();
      assert.equal(existsSync(lockPath), false, 'lock file gone after release');

      // Idempotent: second release is a no-op.
      assert.doesNotThrow(() => handle.release());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second acquire while held times out', async () => {
    const dir = mkTmp();
    try {
      const lockPath = join(dir, 'b.lock');
      const first = await acquireLock(lockPath, { timeoutMs: 200 });

      const start = Date.now();
      await assert.rejects(
        () => acquireLock(lockPath, { timeoutMs: 200, retryMs: 20 }),
        /timeout after 200ms/,
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 180, `expected ≥180ms wait, got ${elapsed}ms`);

      first.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a queued acquire succeeds once the holder releases', async () => {
    const dir = mkTmp();
    try {
      const lockPath = join(dir, 'c.lock');
      const first = await acquireLock(lockPath, { timeoutMs: 500 });

      // Start a competing acquire that will spin until first releases.
      const competitor = acquireLock(lockPath, { timeoutMs: 1000, retryMs: 25 });

      // Hold for ~80 ms then release.
      await sleep(80);
      first.release();

      const second = await competitor;
      assert.equal(existsSync(lockPath), true, 'lock file re-created');
      second.release();
      assert.equal(existsSync(lockPath), false, 'lock file gone after second release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('release allows another *process* to acquire the same lock', async () => {
    const dir = mkTmp();
    try {
      const lockPath = join(dir, 'cross-proc.lock');

      // Phase A: this process holds the lock.
      const handle = await acquireLock(lockPath, { timeoutMs: 500 });
      assert.equal(existsSync(lockPath), true);

      // Phase B: spawn a child that should fail to acquire (timeout fast).
      const blockedChild = await runChild([
        '--mode=acquire',
        `--lock=${lockPath}`,
        '--timeout=120',
        '--retry=20',
      ]);
      assert.notEqual(
        blockedChild.code,
        0,
        `expected child to fail while parent holds; stderr=${blockedChild.stderr}`,
      );
      assert.match(blockedChild.stderr, /timeout/i);

      // Phase C: release, then spawn a fresh child that must succeed.
      handle.release();
      const freeChild = await runChild([
        '--mode=acquire-and-release',
        `--lock=${lockPath}`,
        '--timeout=500',
        '--retry=25',
      ]);
      assert.equal(
        freeChild.code,
        0,
        `expected child to succeed after parent release; stderr=${freeChild.stderr}`,
      );
      assert.equal(existsSync(lockPath), false, 'child cleaned up the lock on release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Spawn a small Node child that exercises lock.mjs and return
 * `{ code, stdout, stderr }`.
 *
 * Modes:
 *   - acquire: try to acquire and exit 0 holding it (lock leaks; only used
 *     in flows where the parent does not need it again)
 *   - acquire-and-release: acquire, release, exit 0
 */
function runChild(extraArgs) {
  return new Promise((resolve, reject) => {
    // Note: \`node --input-type=module -e CODE -- arg1 arg2\` exposes the
    // user args at process.argv[1..]; argv[0] is the node binary path. We
    // filter for tokens beginning with '--' to be defensive.
    const code = `
      import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
      const args = Object.fromEntries(
        process.argv
          .filter((a) => typeof a === 'string' && a.startsWith('--'))
          .map((a) => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v];
          }),
      );
      const opts = {
        timeoutMs: Number(args.timeout ?? 500),
        retryMs: Number(args.retry ?? 25),
      };
      try {
        const handle = await acquireLock(args.lock, opts);
        if (args.mode === 'acquire-and-release') {
          handle.release();
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write((err && err.message ? err.message : String(err)) + '\\n');
        process.exit(1);
      }
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', code, '--', ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
