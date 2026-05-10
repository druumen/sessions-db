import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeFirstPrompt,
  stripIdeWrappers,
  stripSystemReminders,
} from '../../lib/sanitize.mjs';

describe('sanitize.mjs', () => {
  describe('stripSystemReminders', () => {
    it('removes a single system-reminder block', () => {
      const out = stripSystemReminders('hello <system-reminder>secret</system-reminder> world');
      assert.equal(out, 'hello  world');
    });

    it('removes multiple multiline blocks', () => {
      const input =
        'a\n<system-reminder>\nbig\nblock\n</system-reminder>\nb\n<system-reminder>x</system-reminder>c';
      assert.equal(stripSystemReminders(input), 'a\n\nb\nc');
    });

    it('handles empty / non-string input safely', () => {
      assert.equal(stripSystemReminders(''), '');
      assert.equal(stripSystemReminders(null), '');
      assert.equal(stripSystemReminders(undefined), '');
      assert.equal(stripSystemReminders(42), '');
    });
  });

  describe('stripIdeWrappers', () => {
    it('removes <ide_opened_file> blocks', () => {
      const out = stripIdeWrappers('<ide_opened_file>/path/to/file</ide_opened_file>real prompt');
      assert.equal(out, 'real prompt');
    });

    it('removes <command-name>...</command-message> wrappers', () => {
      const input =
        '<command-name>/loop</command-name><command-args></command-args><command-message>do thing</command-message>tail';
      assert.equal(stripIdeWrappers(input), 'tail');
    });

    it('removes <ide_selection> blocks (P5 patch — discovered leak in production 2026-05-10)', () => {
      const out = stripIdeWrappers(
        '<ide_selection>The user selected the lines 50 to 59 from Untitled-1: foo bar baz</ide_selection>real prompt',
      );
      assert.equal(out, 'real prompt');
    });

    it('removes attribute-bearing <ide_selection lines="50-59"> via \\b anchor', () => {
      const out = stripIdeWrappers(
        '<ide_selection lines="50-59" file="x.ts">leaked code</ide_selection>tail',
      );
      assert.equal(out, 'tail');
    });
  });

  describe('sanitizeFirstPrompt', () => {
    it('returns empty string for pure-wrapper input', () => {
      const wrapperOnly = '<ide_opened_file>/secret/path</ide_opened_file>';
      assert.equal(sanitizeFirstPrompt(wrapperOnly), '');
    });

    it('returns empty string for pure system-reminder input', () => {
      const reminderOnly = '<system-reminder>do not leak</system-reminder>';
      assert.equal(sanitizeFirstPrompt(reminderOnly), '');
    });

    it('strips system-reminder nested inside ide_opened_file', () => {
      // Per the implementation, system-reminders are stripped first, then the
      // outer ide wrapper. The end state should contain neither block and
      // expose only the user-visible prompt that follows.
      const nested =
        '<ide_opened_file>\nirrelevant path\n<system-reminder>secret</system-reminder>\n</ide_opened_file>actual prompt';
      const out = sanitizeFirstPrompt(nested);
      assert.equal(out, 'actual prompt');
    });

    it('NFKC-normalises fullwidth → halfwidth', () => {
      const out = sanitizeFirstPrompt('ABC');
      assert.equal(out, 'ABC');
    });

    it('collapses runs of >=3 newlines to a single paragraph break', () => {
      const out = sanitizeFirstPrompt('a\n\n\n\n\nb');
      assert.equal(out, 'a\n\nb');
    });

    it('truncates on a UTF-16 code-point boundary and appends ellipsis', () => {
      // 30 CJK chars + ellipsis at maxLen=10.
      const longCjk = '中文测试'.repeat(10); // 40 code points
      const out = sanitizeFirstPrompt(longCjk, { maxLen: 10 });
      // 9 chars + '…' = 10 code points exactly.
      assert.equal(Array.from(out).length, 10);
      assert.ok(out.endsWith('…'));
      // Must not split a surrogate pair: every code point in `out` must
      // belong to either the BMP or a complete surrogate pair. A round-trip
      // via Array.from + join asserts the string is well-formed UTF-16.
      assert.equal(Array.from(out).join(''), out);
    });

    it('does not append ellipsis when input fits in maxLen', () => {
      const out = sanitizeFirstPrompt('short prompt', { maxLen: 200 });
      assert.equal(out, 'short prompt');
    });

    it('handles emoji (surrogate pairs) without splitting them', () => {
      // Each emoji is one Unicode code point but two UTF-16 code units. We
      // truncate by code-point count, so a 5-emoji limit must yield exactly
      // 5 emoji-equivalents (4 emojis + ellipsis).
      const emojiInput = '😀😁😂🤣😃😄😅😆'; // 8 code points
      const out = sanitizeFirstPrompt(emojiInput, { maxLen: 5 });
      assert.equal(Array.from(out).length, 5);
      assert.ok(out.endsWith('…'));
      // No lone surrogate.
      for (const ch of out) {
        assert.ok(ch.length === 1 || ch.length === 2, `bad char width: ${ch}`);
      }
    });

    it('returns empty string for non-string input', () => {
      assert.equal(sanitizeFirstPrompt(null), '');
      assert.equal(sanitizeFirstPrompt(undefined), '');
      assert.equal(sanitizeFirstPrompt(123), '');
    });

    it('uses default maxLen=200 when opts omitted', () => {
      const longAscii = 'x'.repeat(500);
      const out = sanitizeFirstPrompt(longAscii);
      assert.equal(Array.from(out).length, 200);
    });
  });

  describe('sanitizeFirstPrompt — bypass defenses (codex round-1)', () => {
    it('strips opening tag with trailing whitespace (regex tolerance)', () => {
      // `<system-reminder >` with a trailing space used to slip past a
      // strictly-spelled regex. The `\b[^>]*>` pattern now catches it.
      assert.equal(
        sanitizeFirstPrompt('<system-reminder >A</system-reminder>real'),
        'real',
      );
    });

    it('strips opening tag with attributes', () => {
      // Attribute payload on the opener is benign content, but the tag must
      // still match so the body does not leak.
      assert.equal(
        sanitizeFirstPrompt('<system-reminder data-x="y">SECRET</system-reminder>real'),
        'real',
      );
    });

    it('strips fullwidth-bracket wrappers via NFKC-before-strip ordering', () => {
      // `＜system-reminder＞...＜/system-reminder＞` (U+FF1C / U+FF1E) is the
      // canonical bypass: pre-NFKC the regex does not match, post-NFKC the
      // brackets become ASCII. The fix runs NFKC FIRST so the wrapper is
      // gone before truncation can leak it.
      const input = '＜system-reminder＞A＜/system-reminder＞real';
      assert.equal(sanitizeFirstPrompt(input), 'real');
    });

    it('preserves HTML-entity-encoded tags verbatim (no entity decoding)', () => {
      // Decision: do NOT decode HTML entities. `&lt;system-reminder&gt;` in a
      // user prompt may be legitimate quoted content; decoding before strip
      // would create a fresh injection vector. The contract is byte-faithful
      // pass-through for anything that is not literally a `<tag>...</tag>`.
      const input = '&lt;system-reminder&gt;A&lt;/system-reminder&gt;real';
      assert.equal(sanitizeFirstPrompt(input), input);
    });

    it('strips multiple <ide_opened_file> blocks in series', () => {
      const input =
        '<ide_opened_file>X</ide_opened_file>real<ide_opened_file>Y</ide_opened_file>';
      assert.equal(sanitizeFirstPrompt(input), 'real');
    });

    it('strips multiple <command-name>...</command-message> blocks in series', () => {
      const input =
        '<command-name>/loop</command-name><command-args></command-args><command-message>do thing</command-message>middle<command-name>/foo</command-name><command-args></command-args><command-message>another</command-message>';
      assert.equal(sanitizeFirstPrompt(input), 'middle');
    });

    it('double-pass strip catches a wrapper revealed by removing a sibling', () => {
      // Concrete splice: `<system-reminder>X</system-` then an IDE wrapper
      // then `reminder>tail`. After first pass strips the IDE wrapper the
      // text reads as a fresh `<system-reminder>X</system-reminder>tail`,
      // which the second pass removes. Without pass-2 the body would leak.
      const input =
        '<system-reminder>HEAD</system-<ide_opened_file>/p</ide_opened_file>reminder>tail';
      assert.equal(sanitizeFirstPrompt(input), 'tail');
    });
  });

  describe('sanitizeFirstPrompt — extended wrapper allowlist', () => {
    it('strips <system>...</system>', () => {
      assert.equal(
        sanitizeFirstPrompt('<system>SYS_PROMPT</system>real'),
        'real',
      );
    });

    it('strips <thinking>...</thinking>', () => {
      assert.equal(
        sanitizeFirstPrompt('<thinking>chain of thought</thinking>real'),
        'real',
      );
    });

    it('strips <tool_use>...</tool_use>', () => {
      assert.equal(
        sanitizeFirstPrompt('<tool_use>{"name":"x"}</tool_use>real'),
        'real',
      );
    });

    it('strips <tool_result>...</tool_result>', () => {
      assert.equal(
        sanitizeFirstPrompt('<tool_result>OUTPUT_TEXT</tool_result>real'),
        'real',
      );
    });

    it('strips <parameter>...</parameter> (tool call argument body)', () => {
      assert.equal(
        sanitizeFirstPrompt('<parameter>arg-body</parameter>real'),
        'real',
      );
    });

    it('strips <ide_selection>...</ide_selection> end-to-end (P5 patch — production leak shape)', () => {
      const input =
        '<ide_selection>The user selected the lines 50 to 59 from Untitled-1: leaked source code here</ide_selection>actual user prompt';
      assert.equal(sanitizeFirstPrompt(input), 'actual user prompt');
    });

    it('strips a mix of all extended wrappers in one input', () => {
      const input =
        '<system>S</system><thinking>T</thinking><tool_use>U</tool_use><tool_result>R</tool_result><parameter>P</parameter>real';
      assert.equal(sanitizeFirstPrompt(input), 'real');
    });
  });
});
