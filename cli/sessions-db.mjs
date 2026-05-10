#!/usr/bin/env node
/**
 * sessions-db CLI — entry dispatcher.
 *
 * Subcommands:
 *   find          filter sessions
 *   tree          render hub-spoke subtree
 *   alias         set / clear human alias
 *   link          link to task / project (or --remove)
 *   link-parent   set / clear parent_session_id
 *   close         set outcome + closed_at + reason
 *   rebuild       rebuild projection from events.jsonl
 *   sweep         apply activity_state transitions (active → idle → archived)
 *
 * Global flags supported by every handler:
 *   --json        machine-readable JSON output
 *   --root <p>    override storage root (default cwd)
 *   --dry-run     write commands only — print event, don't write
 *   --quiet       silent stdout (exit code only)
 *   --no-color    disable ANSI color (read-only commands)
 *   -h | --help   subcommand help
 *
 * Exit codes:
 *   0  success
 *   1  business error (invalid stable_id, lock timeout, rebuild failure, ...)
 *   2  argparse error (unknown flag, missing required, invalid enum value)
 *   3  unknown command
 *
 * Top-level wrappers:
 *   - uncaughtException / unhandledRejection both exit 1 (verbose stderr only
 *     when DRUUMEN_SESSIONS_DB_VERBOSE is set, to keep noise out of CI logs).
 *   - Subcommand handlers call process.exit() themselves on business errors;
 *     the dispatcher only sets the exit code on uncaught throws.
 */

const COMMANDS = {
  find: () => import('./find.mjs'),
  tree: () => import('./tree.mjs'),
  alias: () => import('./alias.mjs'),
  link: () => import('./link.mjs'),
  'link-parent': () => import('./link-parent.mjs'),
  close: () => import('./close.mjs'),
  rebuild: () => import('./rebuild.mjs'),
  sweep: () => import('./sweep.mjs'),
};

function printRootHelp() {
  const lines = [
    'Usage: sessions-db <command> [args]',
    '',
    'Commands:',
    '  find          Filter sessions by task / project / alias / branch / cwd / state / outcome',
    '  tree          Render hub-spoke parent → children subtree',
    '  alias         Set / change / clear a session alias',
    '  link          Link a session to a task or project (or --remove via session_unlink)',
    '  link-parent   Set / clear parent_session_id',
    '  close         Set outcome + closed_at + reason (or reopen)',
    '  rebuild       Rebuild projection cache from events.jsonl',
    '  sweep         Apply activity_state transitions (active → idle → archived)',
    '',
    'Run `sessions-db <command> --help` for subcommand-specific flags.',
    '',
    'Global flags supported by all commands:',
    '  --json        JSON output',
    '  --root <p>    override storage root (default cwd)',
    '  --dry-run     write-only — print planned event, do not persist',
    '  --quiet       silent stdout',
    '  --no-color    disable ANSI color',
    '  -h, --help    subcommand help',
    '',
    'Exit codes: 0 success / 1 business error / 2 argparse error / 3 unknown command',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

function printVerboseError(e) {
  if (process.env.DRUUMEN_SESSIONS_DB_VERBOSE) {
    process.stderr.write((e && e.stack) ? e.stack + '\n' : String(e) + '\n');
  } else {
    const msg = e && e.message ? e.message : String(e);
    process.stderr.write(`error: ${msg}\n`);
  }
}

process.on('uncaughtException', (e) => {
  printVerboseError(e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  printVerboseError(e);
  process.exit(1);
});

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printRootHelp();
    process.exit(0);
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(`error: unknown command: ${cmd}\n\n`);
    printRootHelp();
    process.exit(3);
  }

  const mod = await loader();
  if (typeof mod.run !== 'function') {
    process.stderr.write(`error: subcommand ${cmd} did not export run()\n`);
    process.exit(1);
  }
  await mod.run(rest);
}

main();
