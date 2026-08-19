/**
 * Strip every `<system-reminder>...</system-reminder>` block from `s`, plus
 * the related harness/system envelopes (`<system>`, `<thinking>`, `<tool_use>`,
 * `<tool_result>`, `<parameter>`).
 *
 * @param {string} s
 * @returns {string}
 */
export function stripSystemReminders(s: string): string;
/**
 * Strip IDE/harness wrappers (`<ide_opened_file>...`, `<ide_selection>...`,
 * `<command-name>...</command-message>`).
 * @param {string} s
 * @returns {string}
 */
export function stripIdeWrappers(s: string): string;
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
export function sanitizeFirstPrompt(raw: string, opts?: {
    maxLen?: number;
}): string;
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
export function sanitizeNameValue(raw: string): string;
