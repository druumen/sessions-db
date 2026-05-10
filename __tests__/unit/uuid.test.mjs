import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateSessionId, isSessionId, extractTimestamp } from '../uuid.mjs';

describe('uuid.mjs', () => {
  it('generateSessionId returns a `sess_` prefixed UUIDv7 string', () => {
    const id = generateSessionId();
    assert.equal(typeof id, 'string');
    assert.ok(id.startsWith('sess_'), `expected sess_ prefix, got ${id}`);
    // 8-4-4-4-12 hex with version=7 and variant in {8,9,a,b}.
    const re = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(id, re);
  });

  it('isSessionId accepts valid IDs and rejects garbage', () => {
    const id = generateSessionId();
    assert.equal(isSessionId(id), true);
    assert.equal(isSessionId('sess_not-a-uuid'), false);
    assert.equal(isSessionId('11111111-1111-7111-8111-111111111111'), false);
    assert.equal(isSessionId(''), false);
    assert.equal(isSessionId(null), false);
    assert.equal(isSessionId(undefined), false);
    assert.equal(isSessionId(42), false);
    // v4 (version nibble 4) must be rejected.
    assert.equal(isSessionId('sess_11111111-1111-4111-8111-111111111111'), false);
    // Version 7 but variant 0 (top nibble 0) must be rejected.
    assert.equal(isSessionId('sess_11111111-1111-7111-0111-111111111111'), false);
  });

  it('extractTimestamp returns a unix-ms close to now', () => {
    const before = Date.now();
    const id = generateSessionId();
    const after = Date.now();
    const ts = extractTimestamp(id);
    assert.ok(
      ts >= before - 1 && ts <= after + 1,
      `timestamp ${ts} outside [${before}, ${after}]`,
    );
  });

  it('extractTimestamp throws on malformed input', () => {
    assert.throws(() => extractTimestamp('sess_garbage'), /not a sessions-db id/);
    assert.throws(() => extractTimestamp(''), /not a sessions-db id/);
  });

  it('1000 successive IDs are strictly monotonic by embedded timestamp', () => {
    const N = 1000;
    let prevTs = 0;
    let prevId = '';
    for (let i = 0; i < N; i++) {
      const id = generateSessionId();
      const ts = extractTimestamp(id);
      assert.ok(ts >= prevTs, `iteration ${i}: ts ${ts} < prev ${prevTs}`);
      // Lexical ordering must follow timestamp ordering for v7 (within the
      // 12-bit rand_a counter; the rest is random so we only assert >=).
      if (ts === prevTs && prevId !== '') {
        assert.ok(id > prevId, `iteration ${i}: id ${id} <= prev ${prevId} at same ts`);
      }
      prevTs = ts;
      prevId = id;
    }
  });

  it('1000 successive IDs are unique', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) ids.add(generateSessionId());
    assert.equal(ids.size, 1000);
  });
});
