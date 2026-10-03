/** Metadata-only backfill for already indexed Codex identities. */
import { syncCodexNames } from '../lib/codex-names.mjs';
import { looksLikeUuid } from '../lib/hook-common.mjs';
import { parseArgs, formatHelp, ArgparseError } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = { flags: {
  '--yes': { type:'boolean' }, '--dry-run': { type:'boolean' },
  '--json': { type:'boolean' }, '--quiet': { type:'boolean' },
  '--root': { type:'string' }, '--codex-home': { type:'string' }, '--session-id': { type:'string' },
} };
const HELP = formatHelp({ usage:'sessions-db sync-codex-names [--session-id <uuid>] [--yes]',
  summary:'Sync thread_name from Codex session_index.jsonl for identities already in this database.\n' +
    'Metadata only: no rollout scan. Dry run by default; --yes appends changed names.',
  flags:[ {name:'--yes',desc:'write changed names'}, {name:'--dry-run',desc:'preview only (default)'},
    {name:'--session-id <uuid>',desc:'one already indexed full Codex UUID'},
    {name:'--codex-home <path>',desc:'override CODEX_HOME / ~/.codex'},
    {name:'--root <path>',desc:'override storage root'}, {name:'--json',desc:'JSON output'},
    {name:'--quiet',desc:'silent stdout'} ],
});
export async function run(argv) {
  let parsed;
  try { parsed = parseArgs(argv, SPEC); }
  catch (error) {
    if (!(error instanceof ArgparseError)) throw error;
    process.stderr.write(`error: ${error.message}\n`); process.exit(2);
  }
  if (parsed.helpRequested) { process.stdout.write(HELP); return; }
  const flags = parsed.flags;
  if (flags['--yes'] && flags['--dry-run']) {
    process.stderr.write('error: --yes and --dry-run are mutually exclusive\n'); process.exit(2);
  }
  const sessionId = flags['--session-id'];
  if (sessionId && !looksLikeUuid(sessionId)) {
    process.stderr.write('error: invalid Codex session_id\n'); process.exit(2);
  }
  const result = await syncCodexNames({ dryRun:flags['--yes'] !== true, sessionId,
    codexHome:flags['--codex-home'], storage:flags['--root'] ? {root:flags['--root']} : {} });
  if (flags['--quiet']) return;
  process.stdout.write(flags['--json'] ? formatJSON(result) :
    `${result.dryRun ? 'DRY RUN: would sync' : 'Synced'} ${result.changed} Codex name(s); ${result.missing} without a name.\n`);
}
