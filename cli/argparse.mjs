/**
 * Minimal hand-rolled argparse for sessions-db CLI subcommands.
 *
 * Why not `node:util.parseArgs`? Three reasons:
 *  - We want subcommand-local exit codes (2 for argparse error) with custom
 *    error messages that point at the offending flag — `parseArgs` throws
 *    generic TypeError which is hard to surface as a CLI banner without
 *    adding a wrapping layer anyway.
 *  - We want to support both `--flag value` AND `--flag=value` AND repeated
 *    flags (collected as arrays) without each handler reimplementing the
 *    same plumbing.
 *  - Zero-dependency per the P4 ticket constraint, and parseArgs API has
 *    differed across Node versions (we're testing on the same major used by
 *    hooks/tests). A locally-owned 100-line parser is easier to debug than a
 *    wire-up around a stdlib that occasionally changes shape.
 *
 * Spec object shape:
 *   {
 *     positional: [
 *       { name: 'stable_id', required: true },
 *       { name: 'alias', required: false },
 *     ],
 *     // Opt-in: when true, accept any number of extra positionals beyond the
 *     // declared slots and stash them in `positionalArray` for the caller.
 *     // Default false: extra positionals are an argparse error (exit 2).
 *     restPositional: false,
 *     flags: {
 *       '--task':    { type: 'string',  alias: '-t' },
 *       '--remove':  { type: 'boolean' },
 *       '--limit':   { type: 'number', default: 50 },
 *       '--label':   { type: 'string', repeatable: true }, // collected as array
 *       '--json':    { type: 'boolean' },
 *       '--root':    { type: 'string' },
 *       '--dry-run': { type: 'boolean' },
 *       '--quiet':   { type: 'boolean' },
 *     },
 *     help: 'subcommand-specific help text',
 *   }
 *
 * Boolean flag value semantics (P4 round-1 review fix):
 *   `--flag` (no value)        → true
 *   `--flag=true|1|yes`        → true
 *   `--flag=false|0|no`        → false
 *   `--flag value` (spaced)    → REJECTED (would silently swallow value as
 *                                an extra positional, masking user intent).
 *   This is consistent with `parseArgs` in node:util and avoids the trap
 *   where `link --remove false` was previously parsed as `--remove=true`
 *   plus a stray `false` token that got dropped on the floor.
 *
 * Returns:
 *   {
 *     positional: { stable_id: 'sess_...', alias: 'foo' },
 *     positionalArray: ['sess_...', 'foo'],   // raw order
 *     flags: { '--task': 'T-1', '--limit': 50, ... },
 *     helpRequested: false,
 *   }
 *
 * Errors throw `ArgparseError` with `.exitCode = 2` and `.message` ready for
 * stderr. The CLI dispatcher catches these and exits 2 — handlers themselves
 * never need to think about exit codes for parse failures.
 */

const TRUE_BOOL_VALUES = new Set(['true', '1', 'yes']);
const FALSE_BOOL_VALUES = new Set(['false', '0', 'no']);

export class ArgparseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgparseError';
    this.exitCode = 2;
  }
}

/**
 * Parse argv tokens against `spec`. Throws ArgparseError on any violation.
 *
 * @param {string[]} argv
 * @param {object} spec
 * @returns {{
 *   positional: Record<string, string>,
 *   positionalArray: string[],
 *   flags: Record<string, any>,
 *   helpRequested: boolean,
 * }}
 */
export function parseArgs(argv, spec = {}) {
  const positionalSpec = Array.isArray(spec.positional) ? spec.positional : [];
  const flagsSpec = (spec.flags && typeof spec.flags === 'object') ? spec.flags : {};

  // Build alias→canonical map so `-t` resolves to `--task`.
  const aliasMap = {};
  for (const [name, def] of Object.entries(flagsSpec)) {
    if (def && typeof def.alias === 'string' && def.alias.length > 0) {
      aliasMap[def.alias] = name;
    }
  }

  const out = {
    positional: {},
    positionalArray: [],
    flags: {},
    helpRequested: false,
  };

  // Pre-fill defaults for declared flags.
  for (const [name, def] of Object.entries(flagsSpec)) {
    if (def && Object.prototype.hasOwnProperty.call(def, 'default')) {
      out.flags[name] = def.default;
    }
  }

  // Walk argv. Stop if we see `--` (POSIX double-dash separator) — anything
  // after it is treated as positional even if it looks like a flag. This lets
  // callers pass aliases / IDs that begin with `-` without ambiguity.
  let i = 0;
  let sawDoubleDash = false;
  while (i < argv.length) {
    const tok = argv[i];

    if (!sawDoubleDash && tok === '--') {
      sawDoubleDash = true;
      i += 1;
      continue;
    }

    if (!sawDoubleDash && (tok === '-h' || tok === '--help')) {
      out.helpRequested = true;
      i += 1;
      continue;
    }

    // Flag form: `--name`, `--name=value`, or short alias `-x`.
    if (!sawDoubleDash && tok.startsWith('-') && tok !== '-') {
      const eqIdx = tok.indexOf('=');
      let rawName;
      let inlineValue;
      if (eqIdx !== -1) {
        rawName = tok.slice(0, eqIdx);
        inlineValue = tok.slice(eqIdx + 1);
      } else {
        rawName = tok;
        inlineValue = undefined;
      }

      // Resolve short alias to canonical.
      const canonical = aliasMap[rawName] || rawName;
      const def = flagsSpec[canonical];
      if (!def) {
        throw new ArgparseError(`unknown flag: ${rawName}`);
      }

      const type = def.type || 'string';

      if (type === 'boolean') {
        let value;
        if (inlineValue !== undefined) {
          if (TRUE_BOOL_VALUES.has(inlineValue.toLowerCase())) value = true;
          else if (FALSE_BOOL_VALUES.has(inlineValue.toLowerCase())) value = false;
          else {
            throw new ArgparseError(
              `boolean flag ${canonical} got non-boolean value: ${inlineValue}`,
            );
          }
        } else {
          // P4 round-1 review fix: reject `--flag value` (spaced) form for
          // booleans. Previously `--remove false` parsed as `--remove=true`
          // with `false` silently consumed as an extra positional — masking
          // user intent. The acceptable forms are `--flag` and `--flag=value`.
          const next = argv[i + 1];
          if (
            next !== undefined
            && (TRUE_BOOL_VALUES.has(next.toLowerCase())
              || FALSE_BOOL_VALUES.has(next.toLowerCase()))
          ) {
            throw new ArgparseError(
              `boolean flag ${canonical} does not accept a positional value: ${next} `
              + `(use ${canonical}=${next} if you meant to set it explicitly)`,
            );
          }
          value = true;
        }
        out.flags[canonical] = value;
        i += 1;
        continue;
      }

      // string / number — need a value (either inline or next token).
      let raw;
      if (inlineValue !== undefined) {
        raw = inlineValue;
        i += 1;
      } else {
        if (i + 1 >= argv.length) {
          throw new ArgparseError(`flag ${canonical} requires a value`);
        }
        raw = argv[i + 1];
        // Don't allow the next token to be another flag if it looks like one.
        // This catches typos like `--task --json` where the user forgot the
        // task value — better to fail than silently consume `--json` as the
        // task identifier.
        if (raw.startsWith('-') && raw !== '-' && !/^-?\d/.test(raw)) {
          throw new ArgparseError(
            `flag ${canonical} requires a value (got next flag ${raw})`,
          );
        }
        i += 2;
      }

      let value;
      if (type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new ArgparseError(`flag ${canonical} expects a number, got: ${raw}`);
        }
        value = n;
      } else {
        // string (default)
        value = raw;
      }

      if (def.repeatable === true) {
        const cur = out.flags[canonical];
        if (Array.isArray(cur)) cur.push(value);
        else out.flags[canonical] = [value];
      } else {
        out.flags[canonical] = value;
      }
      continue;
    }

    // Positional.
    out.positionalArray.push(tok);
    i += 1;
  }

  // Map positionalArray → named positional slots.
  for (let p = 0; p < positionalSpec.length; p++) {
    const ps = positionalSpec[p];
    if (!ps || typeof ps.name !== 'string') continue;
    if (p < out.positionalArray.length) {
      out.positional[ps.name] = out.positionalArray[p];
    }
  }

  // Validate required positionals (skip if --help was requested — caller
  // should print help and bail before we ever validate).
  if (!out.helpRequested) {
    for (const ps of positionalSpec) {
      if (ps && ps.required === true && !(ps.name in out.positional)) {
        throw new ArgparseError(`missing required positional: ${ps.name}`);
      }
    }
    // P4 round-1 review fix: reject extra positionals unless the spec
    // opts in via `restPositional: true`. Previously `tree <id> garbage`
    // silently dropped the trailing token — an operator typo would not
    // surface and they'd get unexpected output.
    if (spec.restPositional !== true && out.positionalArray.length > positionalSpec.length) {
      const extras = out.positionalArray.slice(positionalSpec.length);
      throw new ArgparseError(
        `unexpected extra positional argument(s): ${extras.join(' ')}`,
      );
    }
  }

  return out;
}

/**
 * Render a help banner for a subcommand. Composed by the subcommand handler
 * (passes its own usage line + flag descriptions). Returns a string ending
 * with a newline so the caller can `process.stdout.write()` directly.
 *
 * @param {{ usage: string, summary?: string, flags?: Array<{ name: string, desc: string }>, examples?: string[] }} parts
 */
export function formatHelp(parts) {
  const lines = [];
  lines.push(`Usage: ${parts.usage}`);
  if (parts.summary) {
    lines.push('');
    lines.push(parts.summary);
  }
  if (Array.isArray(parts.flags) && parts.flags.length > 0) {
    lines.push('');
    lines.push('Flags:');
    const width = parts.flags.reduce((m, f) => Math.max(m, f.name.length), 0);
    for (const f of parts.flags) {
      lines.push(`  ${f.name.padEnd(width)}  ${f.desc}`);
    }
  }
  if (Array.isArray(parts.examples) && parts.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of parts.examples) lines.push(`  ${ex}`);
  }
  return lines.join('\n') + '\n';
}
