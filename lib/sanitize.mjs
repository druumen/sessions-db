/**
 * First-prompt sanitizer for sessions-db.
 *
 * Why this exists: the first user message of a Claude Code transcript is
 * routinely wrapped in injected blocks emitted by the IDE bridge or by the
 * harness itself:
 *   - `<system-reminder>...</system-reminder>` — system/harness reminders.
 *   - `<system>...</system>` — generic system prompt envelope.
 *   - `<thinking>...</thinking>` — chain-of-thought leak guard.
 *   - `<tool_use>...</tool_use>` — assistant tool call (echoed back).
 *   - `<tool_result>...</tool_result>` — tool output echo.
 *   - `<parameter>...</parameter>` — tool call argument body.
 *   - `<ide_opened_file>...</ide_opened_file>` — IDE "user has this file
 *     open" hint, which leaks file paths.
 *   - `<ide_selection>...</ide_selection>` — IDE "user highlighted these
 *     lines" hint, which leaks selected source code into the prompt preview.
 *   - `<command-name>...</command-message>` — slash command wrapper.
 * If we naively persisted that text to disk we would (a) leak file paths and
 * other IDE state, and (b) blow the preview budget on noise instead of the
 * user's actual prompt. So we NFKC-normalise first (fold fullwidth → ASCII so
 * disguised tags get caught), strip the wrappers in two passes (defensive
 * against a wrapper revealed only after a sibling is removed), then trim and
 * truncate to a safe preview length (default 200) on a UTF-16 code-point
 * boundary so multi-byte characters survive intact.
 *
 * Note on HTML entities: we DO NOT entity-decode. `&lt;system-reminder&gt;`
 * stays literally `&lt;system-reminder&gt;` in the preview — entities can be
 * legitimate user content (e.g., quoted code), and decoding them before
 * stripping would create a brand-new injection vector. The sanitizer's
 * contract is byte-faithful pass-through for anything that is not an actual
 * `<tag>...</tag>` wrapper.
 */

// All opening tags use `<TAG\b[^>]*>` so a trailing space or attribute (e.g.
// `<system-reminder >` or `<system-reminder data-x="y">`) cannot bypass the
// match. `\b` anchors the tag name so `<system-reminderXYZ>` does NOT match.
const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
const SYSTEM_RE = /<system\b[^>]*>[\s\S]*?<\/system>/gi;
const THINKING_RE = /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi;
const TOOL_USE_RE = /<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi;
const TOOL_RESULT_RE = /<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi;
const PARAMETER_RE = /<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi;

const IDE_OPENED_RE = /<ide_opened_file\b[^>]*>[\s\S]*?<\/ide_opened_file>/gi;
// IDE injects user's editor selection (highlighted source lines + file path).
// Discovered in production 2026-05-10 leaking selected code into preview.
const IDE_SELECTION_RE = /<ide_selection\b[^>]*>[\s\S]*?<\/ide_selection>/gi;
// Slash-command wrapper opens with <command-name> and closes with the
// trailing </command-message> tag (not a typo — that is the actual shape).
const COMMAND_WRAPPER_RE = /<command-name\b[^>]*>[\s\S]*?<\/command-message>/gi;

/**
 * Strip every `<system-reminder>...</system-reminder>` block from `s`, plus
 * the related harness/system envelopes (`<system>`, `<thinking>`, `<tool_use>`,
 * `<tool_result>`, `<parameter>`).
 *
 * @param {string} s
 * @returns {string}
 */
export function stripSystemReminders(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(SYSTEM_REMINDER_RE, '')
    .replace(SYSTEM_RE, '')
    .replace(THINKING_RE, '')
    .replace(TOOL_USE_RE, '')
    .replace(TOOL_RESULT_RE, '')
    .replace(PARAMETER_RE, '');
}

/**
 * Strip IDE/harness wrappers (`<ide_opened_file>...`, `<ide_selection>...`,
 * `<command-name>...</command-message>`).
 * @param {string} s
 * @returns {string}
 */
export function stripIdeWrappers(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(IDE_OPENED_RE, '')
    .replace(IDE_SELECTION_RE, '')
    .replace(COMMAND_WRAPPER_RE, '');
}

/**
 * Sanitise a raw first-prompt string for safe persistence.
 *
 * Order matters and is the result of an adversarial review:
 *   1. NFKC normalise FIRST. Fullwidth bracket variants (e.g.
 *      `＜system-reminder＞`) only fold into ASCII `<>` after NFKC; if we
 *      stripped before normalising the wrapper would survive the strip pass
 *      and then leak its body once normalisation happens.
 *   2. Strip system-reminders + system envelopes.
 *   3. Strip IDE/harness wrappers.
 *   4. Defensive second pass: re-strip both families. Removing one wrapper
 *      can splice together text that now reads as a fresh wrapper (e.g.
 *      `<sys` + IDE block + `tem>...</system>`); the second pass closes that.
 *   5. Trim and collapse runs of 3+ newlines to a paragraph break.
 *   6. Truncate to `maxLen` (default 200) on a code-point boundary, append `…`.
 *
 * @param {string} raw
 * @param {{ maxLen?: number }} [opts]
 * @returns {string}
 */
export function sanitizeFirstPrompt(raw, opts = {}) {
  if (typeof raw !== 'string') return '';
  const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : 200;

  let s = raw;
  // (1) NFKC FIRST so fullwidth `＜...＞` becomes ASCII before strip runs.
  s = s.normalize('NFKC');
  // (2-3) First strip pass.
  s = stripSystemReminders(s);
  s = stripIdeWrappers(s);
  // (4) Defensive second pass — close the splice-injection gap.
  s = stripSystemReminders(s);
  s = stripIdeWrappers(s);
  // (5) Whitespace tidy.
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  if (s.length <= maxLen) return s;

  // (6) Truncate on a code-point boundary so we never split a surrogate pair.
  // We cap by code-point count (Array.from() iterates code points), then
  // re-join. The ellipsis itself counts toward `maxLen`.
  //
  // Only the first `maxLen * 4` UTF-16 units are materialised. `Array.from(s)`
  // over the whole string is O(n) time and O(n) heap for a function that
  // returns 200 characters: a 32 MB single-line paste measured 442 ms and
  // 328 MB of heap. That was affordable when this ran once per session inside
  // a 2 s budget; since 0.2.0 it runs on every prompt inside a 1 s budget, on
  // raw pasted input, and it is synchronous — so it burns the hook's whole
  // ceiling and the hard timer cannot preempt it (an unref'd timer does not
  // fire while the event loop is blocked).
  //
  // `* 4` is deliberately loose: a code point is at most 2 UTF-16 units, so
  // `maxLen * 2` already guarantees at least `maxLen` code points. The output
  // is therefore identical to slicing the full array — which matters beyond
  // tidiness, because `first_human_prompt_v1` hashes this exact string and a
  // changed truncation would silently re-key every fingerprint written from
  // here on, breaking identity reconciliation against records already on disk.
  // Pinned by a test that diffs old and new behaviour across the boundary.
  const cps = Array.from(s.slice(0, maxLen * 4));
  if (cps.length <= maxLen) return s;
  return cps.slice(0, Math.max(0, maxLen - 1)).join('') + '…';
}

// ---------------------------------------------------------------------------
// Name values
// ---------------------------------------------------------------------------

/**
 * ANSI/VT escape sequences, stripped as whole sequences before the leftover
 * control bytes are dealt with individually.
 *
 * Two families cover what a terminal actually acts on:
 *  - **CSI** (`ESC [ ... final`) — colour, cursor moves, line erase. A name
 *    carrying an erase-line sequence repaints the row it is printed on; a
 *    colour sequence with no reset bleeds over every line after it.
 *  - **OSC** (`ESC ] ... BEL | ST`) — retitles the terminal window from
 *    inside a table cell.
 *
 * Whole-sequence removal has to come first: deleting the ESC on its own would
 * leave `[31m` behind as visible text, which is the worst of both — the name
 * changes AND the junk still shows.
 */
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * C0 controls, DEL, and C1 — plus the two Unicode line separators, which
 * break a line exactly the way a newline does. Mapped to a space rather than
 * deleted, so `fix<LF>the test` reads as `fix the test` and not `fixthe
 * test`: a name that silently fuses two words is a name nobody can search
 * for afterwards.
 */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

/**
 * Invisible characters that change how the REST of the string renders:
 * explicit bidi overrides / isolates, zero-width space, and BOM-as-ZWNBSP.
 * This is the display-spoofing half of the same problem — an RTL override
 * makes everything after it render backwards, so a table cell can show
 * something other than what is stored.
 *
 * Deliberately NOT in this set: ZWJ / ZWNJ (`U+200C`, `U+200D`), which are
 * load-bearing inside emoji sequences and Indic scripts, and LRM / RLM
 * (`U+200E`, `U+200F`), which are marks rather than overrides and occur in
 * legitimate mixed-direction text. Stripping those would corrupt real names
 * to defend against nothing.
 */
const INVISIBLE_RE = /[\u200b\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Sanitise a session **name** for storage and terminal display.
 *
 * Name values reach a TTY unescaped — `sessions-db names <id>` prints them in
 * an aligned table, `find` and `search` print them inline — so a value
 * carrying a raw escape sequence, a NUL, or a newline is not a cosmetic
 * problem: it tears the table apart, and in the escape case it hands control
 * of the terminal to whatever wrote the transcript. Claude Code's
 * `custom-title` is typed by a person into a text field and `agent-name`
 * comes from a badge string, so neither is trustworthy input.
 *
 * This is the runtime counterpart of a source-level control-byte gate: the
 * same class of hazard, arriving as data instead of as code.
 *
 * Applied on the write path (so what lands in `events.jsonl` is already
 * clean) AND when reading an event back (so values written by an older build,
 * or hand-edited into the log, cannot reach a terminal either).
 *
 * **Idempotent by construction** — `sanitizeNameValue(sanitizeNameValue(x))`
 * equals `sanitizeNameValue(x)` for every input. The name reducer compares a
 * stored value against an incoming one to decide whether anything changed, so
 * a sanitiser that kept nibbling would make every re-observation look like a
 * rename. The ordering is what carries that: escapes go first as whole
 * sequences, then controls become spaces, then invisibles are dropped, and
 * only then are runs of spaces collapsed — so a space introduced by an
 * earlier step cannot survive as a double space into the result.
 *
 * ⚠ The last two steps are the ones that look reorderable and are not. Move
 * the collapse ahead of the invisible removal and `a<space><ZWSP><space>b`
 * comes out with a double space, which the next pass then eats — so the
 * function stops being idempotent for every value whose invisibles happen to
 * sit between spaces. It is pinned by an enumerating property test rather
 * than a fixture list (`__tests__/unit/sanitize.test.mjs`), because the whole
 * problem with that swap is that it survives every shape somebody thinks to
 * write down: the failing input needs five parts before it shows.
 *
 * @param {string} raw
 * @returns {string} sanitised value (may be empty — callers treat empty as
 *   "no usable name" rather than storing it)
 */
export function sanitizeNameValue(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CSI_RE, '')
    .replace(OSC_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}
