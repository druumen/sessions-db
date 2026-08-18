/**
 * Transcript discovery over `~/.claude/projects` — exact-identity lookups.
 *
 * These functions replaced a "newest .jsonl in the workspace dir" heuristic
 * that was only ever safe by accident: `workspaceHashFromCwd` used to
 * mis-encode any path containing `_`, a space, `~`, or non-ASCII, so the
 * directory was never found and the heuristic returned nothing. Fixing the
 * hash armed the guess — on a real machine the resolved directory holds 200+
 * transcripts belonging to other sessions, and the newest is essentially never
 * the caller's. The tests below pin the replacement behaviour: a lookup either
 * returns THIS session's file or nothing at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findTranscriptByCsid,
  indexTranscriptCsids,
  workspaceHashFromCwd,
} from '../../lib/transcript.mjs';

function mkTmp(prefix = 'transcript-discovery-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Build a fake `~/.claude/projects` tree and point the library at it via
 * DRUUMEN_CLAUDE_PROJECTS_ROOT (resolved at call time, not module load).
 *
 * @param {Record<string, string[]>} layout dirName -> file basenames
 */
function makeProjectsRoot(layout) {
  const root = mkTmp();
  for (const [dirName, files] of Object.entries(layout)) {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      writeFileSync(join(dir, f), '{"type":"user","sessionId":"x"}\n');
    }
  }
  return root;
}

function withProjectsRoot(root, fn) {
  const prev = process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
  process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = root;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT;
    else process.env.DRUUMEN_CLAUDE_PROJECTS_ROOT = prev;
  }
}

const CSID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

describe('transcript.mjs — findTranscriptByCsid', () => {
  it('finds the transcript whose filename is exactly the csid', () => {
    const root = makeProjectsRoot({ '-Users-x-proj': [`${CSID}.jsonl`] });
    try {
      withProjectsRoot(root, () => {
        assert.equal(findTranscriptByCsid(CSID), join(root, '-Users-x-proj', `${CSID}.jsonl`));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds it in ANY workspace dir, not just the one derived from cwd', () => {
    // This is the useful half of the old fallback: a transcript can land under
    // a different workspace hash than the cwd we were handed (launched from a
    // subdirectory, symlinked cwd, workspace renamed).
    const root = makeProjectsRoot({
      '-Users-x-proj': [`${OTHER}.jsonl`],
      '-Users-x-proj-subdir': [`${CSID}.jsonl`],
    });
    try {
      withProjectsRoot(root, () => {
        assert.equal(
          findTranscriptByCsid(CSID),
          join(root, '-Users-x-proj-subdir', `${CSID}.jsonl`),
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The invariant that matters: no result is better than a wrong result. A
  // foreign transcript would land in transcript_files[] and feed first_uuid /
  // last_uuid into the lineage matcher, which can merge unrelated sessions.
  it('returns null rather than a stranger, even when the dir is full of transcripts', () => {
    const root = makeProjectsRoot({
      '-Users-x-proj': [
        `${OTHER}.jsonl`,
        'cccccccc-1111-2222-3333-444444444444.jsonl',
        'dddddddd-1111-2222-3333-444444444444.jsonl',
      ],
    });
    try {
      withProjectsRoot(root, () => {
        assert.equal(findTranscriptByCsid(CSID), null);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not recurse into subagents/ (agent-<hex> files are never session ids)', () => {
    const root = mkTmp();
    const nested = join(root, '-Users-x-proj', 'parent-session', 'subagents');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, `${CSID}.jsonl`), '{}\n');
    try {
      withProjectsRoot(root, () => {
        assert.equal(findTranscriptByCsid(CSID), null);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never throws on junk input or a missing root', () => {
    withProjectsRoot(join(mkTmp(), 'does-not-exist'), () => {
      assert.equal(findTranscriptByCsid(CSID), null);
      assert.equal(findTranscriptByCsid(''), null);
      assert.equal(findTranscriptByCsid(null), null);
      assert.equal(findTranscriptByCsid(undefined), null);
    });
  });

  // Path-traversal gate, not input validation. The id is joined into
  // `<root>/<dir>/<id>.jsonl`, so a caller passing `../../x` used to escape the
  // projects root entirely and hand back an arbitrary file. The hook callers
  // happen to validate first, but this function is exported from
  // `lib/index.mjs` and its neighbour `pending.mjs` gates the identical input
  // for the identical reason — an exported path builder cannot rely on its
  // callers being careful.
  it('rejects ids that are not canonical UUIDs, so nothing can escape the root', () => {
    const root = mkTmp();
    const outsideDir = join(root, 'outside');
    const insideRoot = join(root, 'projects');
    mkdirSync(join(insideRoot, '-Users-x-proj'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    // A real file the traversal would reach: <projects>/<dir>/../../outside/secret.jsonl
    writeFileSync(join(outsideDir, 'secret.jsonl'), '{}\n');
    try {
      withProjectsRoot(insideRoot, () => {
        assert.equal(findTranscriptByCsid('../outside/secret'), null);
        assert.equal(findTranscriptByCsid('../../outside/secret'), null);
        assert.equal(findTranscriptByCsid(`${CSID}/../../outside/secret`), null);
        // Neighbouring shapes that are also not session ids.
        assert.equal(findTranscriptByCsid('not-a-uuid'), null);
        assert.equal(findTranscriptByCsid(`${CSID}x`), null);
        // Positive control: the gate must not reject a real id.
        writeFileSync(join(insideRoot, '-Users-x-proj', `${CSID}.jsonl`), '{}\n');
        assert.equal(
          findTranscriptByCsid(CSID),
          join(insideRoot, '-Users-x-proj', `${CSID}.jsonl`),
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('transcript.mjs — indexTranscriptCsids', () => {
  it('indexes every top-level jsonl basename across all workspace dirs', () => {
    const root = makeProjectsRoot({
      '-Users-x-a': [`${CSID}.jsonl`, `${OTHER}.jsonl`],
      '-Users-x-b': ['cccccccc-1111-2222-3333-444444444444.jsonl'],
    });
    try {
      withProjectsRoot(root, () => {
        const r = indexTranscriptCsids();
        assert.equal(r.dirCount, 2);
        assert.equal(r.fileCount, 3);
        assert.equal(r.csids.has(CSID), true);
        assert.equal(r.csids.has(OTHER), true);
        assert.equal(r.csids.has('cccccccc-1111-2222-3333-444444444444'), true);
        assert.deepEqual(r.errors, []);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-jsonl files and nested subagent transcripts', () => {
    // Including subagent ids would pollute the index with values that can never
    // appear in claude_session_ids[], which for prune means "looks on disk"
    // for a session that is not.
    const root = makeProjectsRoot({ '-Users-x-a': [`${CSID}.jsonl`, 'notes.md', 'stale.json'] });
    const nested = join(root, '-Users-x-a', 'parent', 'subagents');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'agent-deadbeef.jsonl'), '{}\n');
    try {
      withProjectsRoot(root, () => {
        const r = indexTranscriptCsids();
        assert.equal(r.fileCount, 1);
        assert.deepEqual([...r.csids], [CSID]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing root yields an empty index plus a recorded error, never a throw', () => {
    // Callers treat "not in the index" as "no transcript", so a scan that
    // silently failed WITHOUT surfacing an error would be a licence to delete.
    // The error channel is what lets prune stay honest about partial scans —
    // and `assessScanTrust` (lib/prune.mjs) is the consumer that finally reads
    // it. For a year nothing did.
    const missing = join(mkTmp(), 'nope');
    withProjectsRoot(missing, () => {
      const r = indexTranscriptCsids();
      assert.equal(r.csids.size, 0);
      assert.equal(r.dirCount, 0);
      assert.equal(r.errors.length, 1);
      assert.equal(r.root, missing, 'the scanned root must be reported back');
    });
  });

  it('reports the root it scanned, so a wrong root is recognisable', () => {
    // The failure this makes visible: `sudo`, cron and containers hand us a
    // different HOME, so the scan reads /var/root/.claude/projects cleanly and
    // finds nothing. Without the root in the result, the refusal message
    // cannot say what actually went wrong.
    const root = makeProjectsRoot({ '-Users-x-a': [`${CSID}.jsonl`] });
    try {
      withProjectsRoot(root, () => {
        assert.equal(indexTranscriptCsids().root, root);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('transcript.mjs — workspaceHashFromCwd agrees with real Claude Code dirs', () => {
  // Cross-check against the exact encodings observed in a live
  // ~/.claude/projects listing. These four classes are what the old
  // `replace(/[/.]/g, '-')` got wrong, and all four appear on real machines.
  it('encodes underscore, dot, space, tilde and CJK the same way Claude Code does', () => {
    assert.equal(
      workspaceHashFromCwd('/Users/zm_leng/Documents/druumen/drummen.com_cn'),
      '-Users-zm-leng-Documents-druumen-drummen-com-cn',
    );
    assert.equal(
      workspaceHashFromCwd('/Users/x/Mobile Documents/com~apple~CloudDocs'),
      '-Users-x-Mobile-Documents-com-apple-CloudDocs',
    );
    // Consecutive non-alphanumerics are NOT collapsed — one dash per character.
    assert.equal(workspaceHashFromCwd('/0 personal/留学/x'), '-0-personal----x');
  });

  it('a hash round-trips through findTranscriptByCsid for an underscore path', () => {
    // End-to-end proof that the fixed hash and the discovery helper agree: the
    // directory name is built with the hash, and the lookup finds the file.
    const cwd = '/Users/zm_leng/Documents/druumen/drummen.com_cn';
    const root = makeProjectsRoot({ [workspaceHashFromCwd(cwd)]: [`${CSID}.jsonl`] });
    try {
      withProjectsRoot(root, () => {
        assert.equal(
          findTranscriptByCsid(CSID),
          join(root, workspaceHashFromCwd(cwd), `${CSID}.jsonl`),
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
