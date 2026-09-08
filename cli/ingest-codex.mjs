/**
 * `sessions-db ingest-codex` — register codex sessions from their rollout
 * files. Thin CLI shell; the gates and the write live in
 * `lib/ingest-codex.mjs`.
 *
 * Dry run by default, same posture as `prune` and `harvest`: it is not
 * destructive, but it appends to an append-only log and it reads a directory
 * full of somebody's conversations. "Show me first" is the right default for
 * both halves of that.
 */

import { runIngestCodex } from '../lib/ingest-codex.mjs';
import { isDruumenWorkspace, resolveStorageTarget } from '../lib/hook-common.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = {
  positional: [],
  flags: {
    '--yes': { type: 'boolean' },
    '--dry-run': { type: 'boolean' },
    '--limit': { type: 'number' },
    '--codex-root': { type: 'string' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db ingest-codex [--yes] [--limit <n>]',
  summary:
    'Register codex sessions (~/.codex/sessions/**/rollout-*.jsonl) into this\n' +
    "workspace's database, so `search` can find them alongside Claude Code\n" +
    'sessions. DRY RUN BY DEFAULT: pass --yes to write.\n\n' +
    'Two gates, both refusals by default:\n' +
    '  - the rollout\'s cwd must be a Druumen workspace (same rule as the hooks)\n' +
    '  - and it must be INSIDE the workspace that owns this database, so a\n' +
    '    personal or unrelated directory never lands here.\n\n' +
    'Records land with source="codex" and their id in codex_session_ids[] —\n' +
    'never in claude_session_ids[], which carries Claude-specific identity\n' +
    'resolution. Timestamps come from the rollout, not from the ingest clock.',
  flags: [
    { name: '--yes',            desc: 'actually write the events (without this, report only)' },
    { name: '--dry-run',        desc: 'force report-only (the default; explicit for scripts)' },
    { name: '--limit <n>',      desc: 'stop after n newly ingested sessions (try a small run first)' },
    { name: '--codex-root <p>', desc: 'override ~/.codex/sessions (testing / archived corpora)' },
    { name: '--json',           desc: 'JSON output (machine-readable)' },
    { name: '--root <p>',       desc: 'override storage root (default: this workspace)' },
    { name: '--quiet',          desc: 'silent stdout (exit code only)' },
  ],
  examples: [
    'sessions-db ingest-codex --limit 5     # preview five',
    'sessions-db ingest-codex --json        # preview everything, machine-readable',
    'sessions-db ingest-codex --yes         # write it',
  ],
});

export async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (err) {
    if (err instanceof ArgparseError) {
      process.stderr.write(`error: ${err.message}\n\n${HELP}`);
      process.exit(err.exitCode);
    }
    throw err;
  }
  if (parsed.helpRequested) {
    process.stdout.write(HELP);
    return;
  }

  const explicitDryRun = parsed.flags['--dry-run'] === true;
  const confirmed = parsed.flags['--yes'] === true;
  if (explicitDryRun && confirmed) {
    process.stderr.write('error: --dry-run and --yes are mutually exclusive\n');
    process.exit(2);
  }

  // The workspace is where you are standing. Refusing outside one is not
  // politeness: gate 2 in lib/ingest-codex.mjs compares every rollout's cwd
  // against this value, so a wrong value here would quietly widen the scan
  // instead of failing.
  const workspaceRoot = process.cwd();
  if (!isDruumenWorkspace(workspaceRoot)) {
    process.stderr.write(
      `error: not a Druumen workspace: ${workspaceRoot}\n` +
      '  Run this from the workspace whose database you want to fill.\n',
    );
    process.exit(1);
  }

  const rootFlag = parsed.flags['--root'];
  const storage = rootFlag ? { root: rootFlag } : resolveStorageTarget({ workspaceRoot });

  const result = await runIngestCodex({
    workspaceRoot,
    storage,
    dryRun: !confirmed,
    ...(parsed.flags['--limit'] !== undefined ? { limit: parsed.flags['--limit'] } : {}),
    ...(parsed.flags['--codex-root'] ? { codexRoot: parsed.flags['--codex-root'] } : {}),
  });

  if (parsed.flags['--quiet'] === true) return;
  if (parsed.flags['--json'] === true) {
    process.stdout.write(formatJSON(result));
    return;
  }

  const lines = [];
  lines.push(result.dryRun
    ? `DRY RUN — nothing was written. ${result.ingested} codex session(s) would be registered.`
    : `Registered ${result.ingested} codex session(s).`);
  lines.push(
    `  scanned ${result.scanned} · already known ${result.alreadyKnown} · ` +
    `outside this workspace ${result.skippedOtherWorkspace} · not a Druumen workspace ${result.skippedNotWorkspace} · ` +
    `unreadable ${result.unparseable}`,
  );
  for (const s of result.sessions.slice(0, 20)) {
    const when = s.last_activity_at || s.started_at || '?';
    const who = s.originator ? ` [${s.originator}]` : '';
    const preview = s.first_prompt_preview ? s.first_prompt_preview.slice(0, 60).replace(/\s+/g, ' ') : '(no prompt)';
    lines.push(`  ${s.codex_session_id.slice(0, 8)}  ${when}${who}  ${preview}`);
  }
  if (result.sessions.length > 20) lines.push(`  … and ${result.sessions.length - 20} more`);
  if (result.dryRun && result.ingested > 0) lines.push('Run again with --yes to write.');
  process.stdout.write(lines.join('\n') + '\n');
}
