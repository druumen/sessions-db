#!/usr/bin/env node
import { readStdinJson } from '../lib/hook-common.mjs';
import { runCodexHook } from '../lib/codex-hook.mjs';

try {
  const input = await readStdinJson({ timeoutMs: 1000 });
  if (!input) throw new Error('missing or malformed hook JSON');
  await runCodexHook(input);
} catch (error) {
  process.stderr.write(`sessions-db Codex hook: ${error.message}\n`);
  process.exitCode = 1;
}
