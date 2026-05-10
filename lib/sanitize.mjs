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
  const cps = Array.from(s);
  if (cps.length <= maxLen) return s;
  return cps.slice(0, Math.max(0, maxLen - 1)).join('') + '…';
}
