/**
 * Unit tests for `lib/watch.mjs` — fs.watch + polling fallback + debounce.
 *
 * These tests exercise the real fs.watch + setInterval surface (no mocks).
 * Timing constants are deliberately tight (debounceMs=50, pollIntervalMs=100)
 * so the suite stays under a second. We use `await sleep(N)` rather than
 * fake timers because we want to confirm the actual fs.watch + interval
 * integration, not just the scheduling logic.
 *
 * Test environment caveat: fs.watch on macOS coalesces aggressively under
 * load. To make the "fs.watch fires on write" assertion robust, we wait
 * `> debounceMs + pollIntervalMs * 2` between write and assertion — long
 * enough for the polling fallback to definitely have noticed even if
 * fs.watch dropped the change. The test only asserts that the listener
 * was called at least once; it does NOT pin which signal source caught it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { watchProjection } from '../../lib/watch.mjs';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'sessions-db-watch-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plantProjection(root, body = '{"_meta":{},"sessions":{}}') {
  // Day 4 layout: rootPath IS the storage dir, projection lives directly
  // inside (no `tickets/_logs/` prefix). The legacy form is still supported
  // by passing `opts.paths.projectionJson` to watchProjection — see the
  // backward-compat test below.
  mkdirSync(root, { recursive: true });
  const path = join(root, 'sessions-db.json');
  writeFileSync(path, body);
  return path;
}

describe('watchProjection', () => {
  it('fires listener within debounce window after a write', async () => {
    const root = mkTmp();
    const events = [];
    let watcher;
    try {
      const path = plantProjection(root);
      watcher = watchProjection(
        root,
        (e) => events.push(e),
        { debounceMs: 30, pollIntervalMs: 100 },
      );

      // Initial wait so the watcher attaches + baseline mtime captured.
      await sleep(50);
      // Write modifies mtime — both fs.watch + poll should detect it.
      writeFileSync(path, `{"_meta":{"updated":"${new Date().toISOString()}"},"sessions":{}}`);
      // Wait long enough for debounce + poll fallback.
      await sleep(400);

      assert.ok(events.length >= 1, `expected >=1 listener call, got ${events.length}`);
      assert.equal(events[0].path, path);
      assert.ok(['change', 'rename', 'poll'].includes(events[0].type));
    } finally {
      if (watcher) watcher.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('debounces a rapid burst of writes into a single listener call', async () => {
    const root = mkTmp();
    const events = [];
    let watcher;
    try {
      const path = plantProjection(root);
      watcher = watchProjection(
        root,
        (e) => events.push(e),
        // Long debounce → guarantees burst collapse. Polling interval long
        // so we don't get a poll-driven extra call after the burst settles.
        { debounceMs: 200, pollIntervalMs: 5000 },
      );

      await sleep(50);
      // 5 writes within ~50ms — all should collapse into ONE listener call.
      for (let i = 0; i < 5; i++) {
        writeFileSync(path, `{"_meta":{"i":${i}},"sessions":{}}`);
        await sleep(8);
      }
      // Wait past the debounce window.
      await sleep(400);

      assert.equal(events.length, 1, `expected exactly 1 collapsed call, got ${events.length}`);
    } finally {
      if (watcher) watcher.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('polling fallback fires even when fs.watch is silent (file initially missing)', async () => {
    // When the file doesn't exist yet, fs.watch can't attach. The poll
    // loop must still detect the file's appearance and fire.
    const root = mkTmp();
    const events = [];
    let watcher;
    try {
      // Day 4 layout: rootPath IS the storage dir; projection lives directly
      // inside as `sessions-db.json`.
      const path = join(root, 'sessions-db.json');
      // Start the watcher with NO file present.
      watcher = watchProjection(
        root,
        (e) => events.push(e),
        { debounceMs: 30, pollIntervalMs: 100 },
      );

      // Wait a tick so the watcher's poll loop runs once with "file
      // missing" baseline.
      await sleep(150);
      // Now create the file. The poll loop should notice within
      // pollIntervalMs and fire (fs.watch may or may not catch it
      // depending on attach timing, but poll is the load-bearing path).
      writeFileSync(path, '{"_meta":{},"sessions":{}}');
      await sleep(400);

      assert.ok(events.length >= 1, `polling fallback should have fired (got ${events.length})`);
    } finally {
      if (watcher) watcher.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dispose() removes both fs.watch and polling interval', async () => {
    const root = mkTmp();
    const events = [];
    let watcher;
    try {
      const path = plantProjection(root);
      watcher = watchProjection(
        root,
        (e) => events.push(e),
        { debounceMs: 20, pollIntervalMs: 50 },
      );
      await sleep(50);
      // Dispose immediately, then perform a write.
      watcher.dispose();
      watcher = null;
      writeFileSync(path, '{"_meta":{"after_dispose":true},"sessions":{}}');
      await sleep(300);

      assert.equal(events.length, 0, `disposed watcher must NOT fire (got ${events.length})`);
    } finally {
      if (watcher) watcher.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects bad inputs (no rootPath / no listener)', async () => {
    assert.throws(() => watchProjection('', () => {}), /rootPath required/);
    assert.throws(() => watchProjection('/tmp', null), /listener function required/);
  });

  it('listener errors are swallowed so a buggy consumer cannot kill the loop', async () => {
    const root = mkTmp();
    let calls = 0;
    let watcher;
    try {
      const path = plantProjection(root);
      watcher = watchProjection(
        root,
        () => {
          calls++;
          throw new Error('intentional crash from listener');
        },
        { debounceMs: 20, pollIntervalMs: 100 },
      );
      await sleep(50);
      writeFileSync(path, '{"_meta":{"a":1},"sessions":{}}');
      await sleep(250);
      writeFileSync(path, '{"_meta":{"b":2},"sessions":{}}');
      await sleep(400);

      // Listener must have been called more than once despite throwing
      // each time — the watcher must survive the exception.
      assert.ok(calls >= 2, `expected listener invoked >=2x despite throws, got ${calls}`);
    } finally {
      if (watcher) watcher.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
