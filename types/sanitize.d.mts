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
