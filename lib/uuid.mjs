/**
 * UUIDv7 generator for sessions-db stable IDs.
 *
 * Spec: RFC 9562 §5.7 — UUIDv7 (Unix Epoch time-ordered).
 * Layout (128 bits, big-endian):
 *   - bits 0..47   : 48-bit unix timestamp in milliseconds
 *   - bits 48..51  : 4-bit version (= 0b0111 = 7)
 *   - bits 52..63  : 12 bits of random "rand_a"
 *   - bits 64..65  : 2-bit IETF variant (= 0b10)
 *   - bits 66..127 : 62 bits of random "rand_b"
 *
 * Output format: `sess_<uuidv7-with-dashes>`
 *
 * Notes:
 * - Node 22's `crypto.randomUUID` always emits v4; the `{version:7}` option
 *   is silently ignored. We implement the bit layout ourselves with
 *   `crypto.randomFillSync` (16 bytes, then patch the version + variant
 *   nibbles, then write the timestamp big-endian into the first 6 bytes).
 * - To preserve monotonic ordering when multiple IDs are generated within
 *   the same millisecond we keep the previous timestamp around and bump
 *   the 12-bit `rand_a` counter when a collision is detected. Across
 *   millisecond boundaries `rand_a` is fully random.
 */

import { randomFillSync } from 'node:crypto';

const PREFIX = 'sess_';
// Matches the canonical 8-4-4-4-12 hex shape with version nibble forced to 7
// and variant nibble in {8,9,a,b}.
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID_RE = new RegExp(`^${PREFIX}${UUIDV7_RE.source.slice(1, -1)}$`);

let lastTimestampMs = -1;
let lastRandA = 0;

/**
 * Generate a fresh `sess_<uuidv7>` string.
 * @returns {string}
 */
export function generateSessionId() {
  const bytes = Buffer.alloc(16);
  randomFillSync(bytes);

  const nowMs = Date.now();
  let timestampMs = nowMs;
  let randA;

  if (nowMs <= lastTimestampMs) {
    // Same-or-earlier millisecond: reuse the previous timestamp and bump
    // rand_a so successive IDs remain strictly monotonic.
    timestampMs = lastTimestampMs;
    randA = (lastRandA + 1) & 0xfff;
    if (randA === 0) {
      // Overflowed the 12-bit counter — advance the timestamp by 1ms so we
      // do not collide with the prior ID.
      timestampMs += 1;
      // randA stays 0 after overflow; rand_b is still random so we keep
      // collision probability negligible.
    }
  } else {
    // Use 12 random bits from the buffer for rand_a.
    randA = ((bytes[6] & 0x0f) << 8) | bytes[7];
  }

  // Write the 48-bit timestamp big-endian into bytes[0..5].
  // (Buffer.writeUIntBE supports up to 6 bytes, exactly 48 bits.)
  bytes.writeUIntBE(timestampMs, 0, 6);

  // bytes[6]: top nibble = version (0x70), bottom nibble = high 4 bits of randA.
  bytes[6] = 0x70 | ((randA >>> 8) & 0x0f);
  // bytes[7]: low 8 bits of randA.
  bytes[7] = randA & 0xff;
  // bytes[8]: top 2 bits = variant 0b10, remaining 6 bits stay random.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  lastTimestampMs = timestampMs;
  lastRandA = randA;

  const hex = bytes.toString('hex');
  const uuid =
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32);

  return PREFIX + uuid;
}

/**
 * Validate a sessions-db session id.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isSessionId(s) {
  return typeof s === 'string' && SESSION_ID_RE.test(s);
}

/**
 * Extract the embedded unix-ms timestamp from a UUIDv7 session id.
 * @param {string} sessionId
 * @returns {number} unix ms
 */
export function extractTimestamp(sessionId) {
  if (!isSessionId(sessionId)) {
    throw new TypeError(`extractTimestamp: not a sessions-db id: ${sessionId}`);
  }
  // Strip prefix, then strip dashes from the first three groups (12 hex chars
  // = 48 bits) and parseInt as base-16. Number is safe since 48 bits < 53.
  const hex = sessionId.slice(PREFIX.length).replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}
