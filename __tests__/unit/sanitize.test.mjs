import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeFirstPrompt,
  sanitizeNameValue,
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

  // ---------------------------------------------------------------------------
  // Truncation cost.
  //
  // This function returns 200 characters, but it used to walk the entire input
  // to get them: `Array.from(s)` materialises one array element per code point,
  // so a 32 MB single-line paste cost ~442 ms and ~328 MB of heap. That was
  // affordable while it ran once per session inside a 2 s budget; since 0.2.0
  // it runs on every prompt inside a 1 s budget, on raw pasted text — and it is
  // synchronous, so it consumes the whole ceiling with the hard timer unable to
  // preempt it (an unref'd timer does not fire on a blocked event loop). A
  // 32 MB paste measured 1994 ms end-to-end, twice the ceiling.
  //
  // The fix slices before materialising. Two things then need pinning: that the
  // work is bounded, and — far more important — that the OUTPUT did not change,
  // because `first_human_prompt_v1` hashes this exact string. A different
  // truncation would silently re-key every fingerprint written from here on and
  // break identity reconciliation against records already on disk.
  // ---------------------------------------------------------------------------
  describe('sanitizeFirstPrompt — bounded truncation cost', () => {
    /** The pre-fix truncation, verbatim, as the equivalence oracle. */
    function referenceTruncate(s, maxLen) {
      if (s.length <= maxLen) return s;
      const cps = Array.from(s);
      if (cps.length <= maxLen) return s;
      return cps.slice(0, Math.max(0, maxLen - 1)).join('') + '…';
    }

    const maxLen = 200;
    const cases = {
      'ascii just under the slice window': 'a'.repeat(maxLen * 4 - 1),
      'ascii exactly at the slice window': 'a'.repeat(maxLen * 4),
      'ascii just over the slice window': 'a'.repeat(maxLen * 4 + 1),
      'ascii far past it': 'a'.repeat(maxLen * 40),
      // Every code point is a surrogate pair, so the string is longer than
      // maxLen in UTF-16 units while holding fewer than maxLen code points —
      // the case where the "fits, return whole" branch must still win.
      'all surrogate pairs, fewer code points than maxLen': '😀'.repeat(maxLen - 5),
      'all surrogate pairs, more code points than maxLen': '😀'.repeat(maxLen * 3),
      // A pair straddling the slice boundary: slicing by code units can cut it
      // in half, so the result must not carry a lone surrogate.
      'surrogate pair straddling the slice boundary': `${'a'.repeat(maxLen * 4 - 1)}😀${'b'.repeat(50)}`,
      'mixed CJK and emoji': '中文😀'.repeat(maxLen),
    };

    for (const [name, input] of Object.entries(cases)) {
      it(`output is byte-identical to the unbounded implementation — ${name}`, () => {
        const out = sanitizeFirstPrompt(input, { maxLen });
        assert.equal(out, referenceTruncate(input, maxLen));
        // Well-formed UTF-16 either way: a round-trip through code points is
        // lossless only when no surrogate was split.
        assert.equal(Array.from(out).join(''), out);
      });
    }

    it('materialises a bounded prefix, not the whole prompt', () => {
      // Asserted by instrumenting Array.from rather than by timing: wall-clock
      // thresholds turn into flakes on a loaded CI box, while "how much did you
      // materialise" is exactly the property that regressed and is machine
      // independent. The measured numbers live in the docstring above.
      const input = 'z'.repeat(4 * 1024 * 1024);
      const original = Array.from;
      const seen = [];
      try {
        Array.from = function instrumented(arg, ...rest) {
          if (typeof arg === 'string') seen.push(arg.length);
          return original.call(Array, arg, ...rest);
        };
        const out = sanitizeFirstPrompt(input, { maxLen });
        assert.equal(Array.from(out).length, maxLen);
      } finally {
        Array.from = original;
      }
      assert.ok(seen.length > 0, 'expected the truncation path to run');
      for (const len of seen) {
        assert.ok(len <= maxLen * 4,
          `materialised ${len} code units for a ${maxLen}-char preview`);
      }
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

// ---------------------------------------------------------------------------
// sanitizeNameValue
// ---------------------------------------------------------------------------

describe('sanitize — sanitizeNameValue', () => {
  it('strips whole ANSI sequences rather than just the ESC byte', () => {
    // Removing ESC alone would leave `[31m` as visible text: the name changes
    // AND the junk still shows. Whole-sequence removal is the only version
    // that is both safe and non-destructive.
    assert.equal(sanitizeNameValue('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(sanitizeNameValue('\x1b[2K'), '', 'erase-line is the whole value');
    assert.equal(sanitizeNameValue('a\x1b]0;retitled\x07b'), 'ab', 'OSC window-title');
  });

  it('turns control bytes into spaces instead of deleting them', () => {
    // A name that silently fuses two words is a name nobody can search for
    // afterwards, so a newline has to stay a word boundary.
    assert.equal(sanitizeNameValue('fix\nthe test'), 'fix the test');
    assert.equal(sanitizeNameValue('tab\there'), 'tab here');
    assert.equal(sanitizeNameValue('nul\x00byte'), 'nul byte');
    assert.equal(sanitizeNameValue('a\u2028b'), 'a b', 'U+2028 breaks a line like LF does');
  });

  it('drops bidi overrides, which change how the rest of the line renders', () => {
    assert.equal(sanitizeNameValue('safe\u202ederevo'), 'safederevo');
    assert.equal(sanitizeNameValue('a\u200bb'), 'ab', 'zero-width space');
  });

  it('keeps the invisibles that carry meaning', () => {
    // ZWJ is load-bearing inside emoji sequences and Indic scripts; stripping
    // it would corrupt real names to defend against nothing.
    const family = 'family \u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    assert.equal(sanitizeNameValue(family), family);
    assert.equal(sanitizeNameValue('naïve café 定价分析'), 'naïve café 定价分析');
  });

  it('is idempotent for every shape it handles', () => {
    // Load-bearing, not tidiness: the name reducer decides "did anything
    // change?" by comparing a stored value against an incoming one, so a
    // sanitiser that kept nibbling would make every re-observation look like
    // a rename and put the set_count bug back.
    for (const raw of [
      'plain', '', '   ', 'a\nb', '\x1b[31mx\x1b[0m', 'a  b', '\u202ex',
      'a\x00\x00b', '  padded  ', 'tab\t\tgap', 'mixed \x1b[1m\nvalue',
      // An invisible BETWEEN spaces — the shape this fixture list was missing,
      // and the only one that distinguishes the real ordering from the
      // plausible-looking wrong one. See the property test below.
      'a \u200b b', 'a\u200b b', 'a \ufeffb',
    ]) {
      const once = sanitizeNameValue(raw);
      assert.equal(sanitizeNameValue(once), once, `not idempotent for ${JSON.stringify(raw)}`);
    }
  });

  it('holds its ordering invariants across every short mix of hazards', () => {
    // A fixture list can only assert the shapes somebody thought of, and the
    // one it did not think of was "an invisible sits between two spaces" —
    // which is exactly where the pipeline order is load-bearing. Removing
    // invisibles BEFORE collapsing spaces turns `a<space><ZWSP><space>b` into
    // `a b`; collapsing first leaves the double space the removal then
    // creates, so `sanitize(sanitize(x)) !== sanitize(x)` and the name reducer
    // starts reading a re-observation as a rename.
    //
    // So this enumerates rather than lists. Note the depth: that shape needs
    // FIVE atoms (anchor, space, invisible, space, anchor) because a run at
    // either end is eaten by the trim instead — a 4-deep sweep passes the
    // broken order happily, which is the same blind spot as the fixture list
    // one level up. Deterministic, no seed, ~180k inputs, ~0.3 s.
    const ATOMS = [
      'a',            // ordinary text
      ' ',            // the character everything else collapses into
      '\u200b',       // zero-width space   — invisible, removed
      '\ufeff',       // BOM as ZWNBSP      — invisible, removed
      '\u202e',       // RTL override       — invisible, removed
      '\u200d',       // ZWJ                — invisible, DELIBERATELY kept
      '\n',           // control            — folded to a space
      '\x00',         // control            — folded to a space
      '\x1b',         // a bare ESC with no sequence behind it
      '\x1b[31m',     // complete CSI
      '\x1b]0;t\x07', // complete OSC
    ];
    // The classes that can produce or absorb a space, swept deeper: a variant
    // of the ordering bug that needs more room to show itself lives here and
    // costs almost nothing to look for.
    const SPACING_ATOMS = ['a', ' ', '\u200b', '\n'];

    const check = (raw) => {
      const once = sanitizeNameValue(raw);
      const shown = JSON.stringify(raw);
      // (1) The contract the reducer depends on.
      assert.equal(sanitizeNameValue(once), once, `not idempotent for ${shown}`);
      // (2) and (3) are how (1) is achieved rather than separate wishes:
      // nothing may leave a space run or an edge space behind, because a
      // second pass would then have work to do.
      assert.ok(!once.includes('  '), `double space left in ${shown} -> ${JSON.stringify(once)}`);
      assert.equal(once, once.trim(), `edge whitespace left in ${shown}`);
    };

    let checked = 0;
    const sweep = (atoms, maxLen) => {
      const walk = (prefix, depth) => {
        if (depth === 0) { check(prefix); checked++; return; }
        for (const atom of atoms) walk(prefix + atom, depth - 1);
      };
      for (let len = 1; len <= maxLen; len++) walk('', len);
    };
    sweep(ATOMS, 5);
    sweep(SPACING_ATOMS, 8);
    assert.ok(checked > 100_000, `expected the full product to be walked, got ${checked}`);
  });

  it('collapses only the space runs it could have created', () => {
    assert.equal(sanitizeNameValue('  spaced   out  '), 'spaced out');
    assert.equal(sanitizeNameValue('a\x00\x00\x00b'), 'a b');
  });

  it('answers empty string for non-strings', () => {
    assert.equal(sanitizeNameValue(null), '');
    assert.equal(sanitizeNameValue(undefined), '');
    assert.equal(sanitizeNameValue(42), '');
  });
});
