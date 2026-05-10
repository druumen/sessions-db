/**
 * Unit tests for `lib/paths.mjs` — the 5-priority storage-path resolver.
 *
 * Coverage:
 *   - Priority 1: explicit `opts.rootPath` wins over everything
 *   - Priority 2: `DRUUMEN_SESSIONS_DB_ROOT` env var when no arg
 *   - Priority 1 > 2: arg wins when both supplied
 *   - Priority 3: cwd-ascend finds existing `tickets/_logs/sessions-db.json`
 *   - Priority 4: cwd-ascend finds existing `.dru-code/sessions-db.json`
 *   - Priority 3 > 4: druumen monorepo wins when both exist
 *   - Priority 5: default `<cwd>/.dru-code/` when nothing else hits
 *   - Multi-level ascend: cwd is N dirs deep below the storage root
 *   - MAX_ASCEND_DEPTH bound: stops climbing instead of walking to /
 *   - Empty-string env var: skipped (falls through to next priority)
 *   - Non-absolute env var: resolved against cwd
 *   - File-paths are joined cross-platform via path.join (no string concat)
 *   - Source field is correctly tagged on every priority hit
 *
 * The resolver is pure aside from `fs.existsSync` and `process.cwd` /
 * `process.env` reads, so all tests use real tmpdirs (no mocks). We restore
 * the env var at the end of each test that mutates it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  MAX_ASCEND_DEPTH,
  STORAGE_FILENAMES,
  pathsFromRoot,
  resolveStoragePaths,
} from '../../lib/paths.mjs';

const ENV_KEY = 'DRUUMEN_SESSIONS_DB_ROOT';

function mkTmp() {
  // realpath the tmpdir result because macOS returns `/var/folders/...`
  // (a symlink) but `process.chdir()` resolves to `/private/var/folders/...`.
  // Without realpath, tests that compare ascend results to the planted root
  // would mismatch the prefix even though the directories are identical.
  return realpathSync(mkdtempSync(join(tmpdir(), 'sessions-db-paths-')));
}

/**
 * Plant a sentinel sessions-db.json at `<dir>/<sub>/sessions-db.json` so the
 * resolver's existence check finds it. `sub` is `tickets/_logs` or
 * `.dru-code` depending on which priority we're exercising.
 */
function plantProjection(dir, sub) {
  const root = join(dir, sub);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, STORAGE_FILENAMES.projectionJson),
    '{"_meta":{},"sessions":{}}',
  );
  return root;
}

/**
 * Run a callback with the env var temporarily set (or cleared). Restores
 * the original value on exit so tests stay isolated.
 */
function withEnv(value, cb) {
  const orig = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return cb();
  } finally {
    if (orig === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = orig;
  }
}

/**
 * Run a callback with cwd temporarily pinned. Useful for tests that exercise
 * the default-mode resolver which reads `process.cwd()` directly.
 */
function withCwd(dir, cb) {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    return cb();
  } finally {
    process.chdir(orig);
  }
}

describe('resolveStoragePaths — priority 1: explicit opts.rootPath', () => {
  it('returns the supplied rootPath verbatim, source=arg', () => {
    const dir = mkTmp();
    try {
      const r = resolveStoragePaths({ rootPath: dir });
      assert.equal(r.source, 'arg');
      assert.equal(r.root, resolve(dir));
      assert.equal(r.eventsJsonl, join(dir, 'sessions-db-events.jsonl'));
      assert.equal(r.projectionJson, join(dir, 'sessions-db.json'));
      assert.equal(r.lockFile, join(dir, 'sessions-db.json.lock'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relative rootPath is resolved against process.cwd()', () => {
    // We just check that the returned root is absolute.
    const r = resolveStoragePaths({ rootPath: 'relative-dir-that-does-not-exist' });
    assert.equal(r.source, 'arg');
    // path.resolve guarantees absolute output
    assert.ok(r.root.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(r.root),
      `expected absolute path, got ${r.root}`);
  });

  it('arg wins over DRUUMEN_SESSIONS_DB_ROOT env var (priority 1 > 2)', () => {
    const argDir = mkTmp();
    const envDir = mkTmp();
    try {
      withEnv(envDir, () => {
        const r = resolveStoragePaths({ rootPath: argDir });
        assert.equal(r.source, 'arg');
        assert.equal(r.root, resolve(argDir));
      });
    } finally {
      rmSync(argDir, { recursive: true, force: true });
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  it('arg wins over an existing tickets/_logs/ in ascend (priority 1 > 3)', () => {
    const argDir = mkTmp();
    const ascendDir = mkTmp();
    try {
      plantProjection(ascendDir, 'tickets/_logs');
      withCwd(ascendDir, () => {
        const r = resolveStoragePaths({ rootPath: argDir });
        assert.equal(r.source, 'arg');
        assert.equal(r.root, resolve(argDir));
      });
    } finally {
      rmSync(argDir, { recursive: true, force: true });
      rmSync(ascendDir, { recursive: true, force: true });
    }
  });
});

describe('resolveStoragePaths — priority 2: env var', () => {
  it('returns env-var root when no opts.rootPath, source=env', () => {
    const envDir = mkTmp();
    try {
      withEnv(envDir, () => {
        const r = resolveStoragePaths();
        assert.equal(r.source, 'env');
        assert.equal(r.root, resolve(envDir));
        assert.equal(r.projectionJson, join(envDir, 'sessions-db.json'));
      });
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  it('empty-string env var is treated as not-set (falls through)', () => {
    const cwdDir = mkTmp();
    try {
      withEnv('', () => {
        withCwd(cwdDir, () => {
          const r = resolveStoragePaths();
          // No existing storage in the tmpdir tree → falls through to default.
          assert.equal(r.source, 'default');
          assert.equal(r.root, join(resolve(cwdDir), '.dru-code'));
        });
      });
    } finally {
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  it('non-absolute env var is resolved to absolute', () => {
    withEnv('relative-env-dir-that-does-not-exist', () => {
      const r = resolveStoragePaths();
      assert.equal(r.source, 'env');
      assert.ok(r.root.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(r.root),
        `expected absolute path, got ${r.root}`);
    });
  });

  it('env wins over existing tickets/_logs/ in ascend (priority 2 > 3)', () => {
    const envDir = mkTmp();
    const ascendDir = mkTmp();
    try {
      plantProjection(ascendDir, 'tickets/_logs');
      withEnv(envDir, () => {
        withCwd(ascendDir, () => {
          const r = resolveStoragePaths();
          assert.equal(r.source, 'env');
          assert.equal(r.root, resolve(envDir));
        });
      });
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      rmSync(ascendDir, { recursive: true, force: true });
    }
  });
});

describe('resolveStoragePaths — priority 3: cwd-ascend tickets/_logs/', () => {
  it('finds tickets/_logs/sessions-db.json in cwd, source=tickets-logs', () => {
    const dir = mkTmp();
    try {
      const planted = plantProjection(dir, 'tickets/_logs');
      withEnv(undefined, () => {
        withCwd(dir, () => {
          const r = resolveStoragePaths();
          assert.equal(r.source, 'tickets-logs');
          assert.equal(r.root, planted);
          assert.equal(r.projectionJson, join(planted, 'sessions-db.json'));
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds tickets/_logs/ via multi-level ascend (3 levels deep)', () => {
    const dir = mkTmp();
    try {
      const planted = plantProjection(dir, 'tickets/_logs');
      const deep = join(dir, 'a', 'b', 'c');
      mkdirSync(deep, { recursive: true });
      withEnv(undefined, () => {
        const r = resolveStoragePaths({ cwd: deep });
        assert.equal(r.source, 'tickets-logs');
        assert.equal(r.root, planted);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tickets-logs wins over .dru-code at the same level (priority 3 > 4)', () => {
    const dir = mkTmp();
    try {
      const ticketsRoot = plantProjection(dir, 'tickets/_logs');
      plantProjection(dir, '.dru-code');
      withEnv(undefined, () => {
        const r = resolveStoragePaths({ cwd: dir });
        assert.equal(r.source, 'tickets-logs');
        assert.equal(r.root, ticketsRoot);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveStoragePaths — priority 4: cwd-ascend .dru-code/', () => {
  it('finds .dru-code/sessions-db.json in cwd, source=dru-code', () => {
    const dir = mkTmp();
    try {
      const planted = plantProjection(dir, '.dru-code');
      withEnv(undefined, () => {
        const r = resolveStoragePaths({ cwd: dir });
        assert.equal(r.source, 'dru-code');
        assert.equal(r.root, planted);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds .dru-code via multi-level ascend (4 levels deep)', () => {
    const dir = mkTmp();
    try {
      const planted = plantProjection(dir, '.dru-code');
      const deep = join(dir, 'x', 'y', 'z', 'w');
      mkdirSync(deep, { recursive: true });
      withEnv(undefined, () => {
        const r = resolveStoragePaths({ cwd: deep });
        assert.equal(r.source, 'dru-code');
        assert.equal(r.root, planted);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveStoragePaths — priority 5: default cwd/.dru-code/', () => {
  it('falls through when nothing else hits, source=default', () => {
    const dir = mkTmp();
    try {
      // No sentinels planted; no env var; no opts.rootPath.
      withEnv(undefined, () => {
        const r = resolveStoragePaths({ cwd: dir });
        assert.equal(r.source, 'default');
        assert.equal(r.root, join(resolve(dir), '.dru-code'));
        assert.equal(r.projectionJson, join(dir, '.dru-code', 'sessions-db.json'));
        assert.equal(r.eventsJsonl, join(dir, '.dru-code', 'sessions-db-events.jsonl'));
        assert.equal(r.lockFile, join(dir, '.dru-code', 'sessions-db.json.lock'));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses process.cwd() when opts.cwd is not provided', () => {
    const dir = mkTmp();
    try {
      withEnv(undefined, () => {
        withCwd(dir, () => {
          const r = resolveStoragePaths();
          assert.equal(r.source, 'default');
          assert.equal(r.root, join(resolve(dir), '.dru-code'));
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveStoragePaths — ascend bound', () => {
  it('MAX_ASCEND_DEPTH is exposed and bounded to a sensible value', () => {
    // Sanity check: not 0 (would break ascend) and not so large we'd walk
    // pathologically deep filesystems.
    assert.ok(MAX_ASCEND_DEPTH >= 6 && MAX_ASCEND_DEPTH <= 32,
      `MAX_ASCEND_DEPTH should be in [6, 32], got ${MAX_ASCEND_DEPTH}`);
  });

  it('does not walk past MAX_ASCEND_DEPTH levels', () => {
    // Plant the projection at the tmpdir root, then ascend from a level
    // that is `MAX_ASCEND_DEPTH + 5` deep — ascend should NOT find it.
    const dir = mkTmp();
    try {
      plantProjection(dir, 'tickets/_logs');
      const segments = Array.from({ length: MAX_ASCEND_DEPTH + 5 }, (_, i) => `d${i}`);
      const tooDeep = join(dir, ...segments);
      mkdirSync(tooDeep, { recursive: true });
      withEnv(undefined, () => {
        const r = resolveStoragePaths({ cwd: tooDeep });
        // Far enough away that the bound prevents discovery → falls to default.
        assert.equal(r.source, 'default');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops cleanly at filesystem root without throwing', () => {
    // Pass `/` directly — should walk one iteration (parent === self) and
    // fall through to default without crashing.
    withEnv(undefined, () => {
      const r = resolveStoragePaths({ cwd: '/' });
      assert.equal(r.source, 'default');
      // Default at cwd=/ is /.dru-code (an ugly but valid path).
      assert.equal(r.root, join('/', '.dru-code'));
    });
  });
});

describe('resolveStoragePaths — cross-platform path joining', () => {
  it('uses path.join (not string concat) so OS separator is honored', () => {
    const dir = mkTmp();
    try {
      const r = resolveStoragePaths({ rootPath: dir });
      // The eventsJsonl + projectionJson + lockFile must all start with
      // root + OS separator. We assert that the substring after root is
      // exactly `<sep><filename>` — no double separators, no missing ones.
      assert.equal(r.eventsJsonl, `${r.root}${sep}sessions-db-events.jsonl`);
      assert.equal(r.projectionJson, `${r.root}${sep}sessions-db.json`);
      assert.equal(r.lockFile, `${r.root}${sep}sessions-db.json.lock`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('STORAGE_FILENAMES', () => {
  it('exposes the canonical three filenames as a frozen object', () => {
    assert.equal(STORAGE_FILENAMES.eventsJsonl, 'sessions-db-events.jsonl');
    assert.equal(STORAGE_FILENAMES.projectionJson, 'sessions-db.json');
    assert.equal(STORAGE_FILENAMES.lockFile, 'sessions-db.json.lock');
    assert.ok(Object.isFrozen(STORAGE_FILENAMES),
      'STORAGE_FILENAMES must be frozen so callers cannot mutate the layout');
  });
});

describe('pathsFromRoot helper', () => {
  it('builds the file triple from an absolute root', () => {
    const dir = mkTmp();
    try {
      const r = pathsFromRoot(dir);
      assert.equal(r.root, dir);
      assert.equal(r.projectionJson, join(dir, 'sessions-db.json'));
      assert.equal(r.eventsJsonl, join(dir, 'sessions-db-events.jsonl'));
      assert.equal(r.lockFile, join(dir, 'sessions-db.json.lock'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative root to absolute', () => {
    const r = pathsFromRoot('rel-dir');
    assert.ok(r.root.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(r.root),
      `expected absolute path, got ${r.root}`);
  });

  it('throws TypeError on empty/missing root', () => {
    assert.throws(() => pathsFromRoot(''), /pathsFromRoot/);
    assert.throws(() => pathsFromRoot(null), /pathsFromRoot/);
    assert.throws(() => pathsFromRoot(undefined), /pathsFromRoot/);
  });
});
