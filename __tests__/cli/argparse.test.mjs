import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ArgparseError, formatHelp, parseArgs } from '../../cli/argparse.mjs';

describe('argparse.mjs', () => {
  describe('parseArgs — flags', () => {
    it('parses --flag value form', () => {
      const r = parseArgs(['--task', 'T-1'], {
        flags: { '--task': { type: 'string' } },
      });
      assert.equal(r.flags['--task'], 'T-1');
    });

    it('parses --flag=value form', () => {
      const r = parseArgs(['--task=T-1'], {
        flags: { '--task': { type: 'string' } },
      });
      assert.equal(r.flags['--task'], 'T-1');
    });

    it('parses boolean flag without value', () => {
      const r = parseArgs(['--json'], {
        flags: { '--json': { type: 'boolean' } },
      });
      assert.equal(r.flags['--json'], true);
    });

    it('parses boolean flag with explicit =true', () => {
      const r = parseArgs(['--dry-run=true'], {
        flags: { '--dry-run': { type: 'boolean' } },
      });
      assert.equal(r.flags['--dry-run'], true);
    });

    it('parses number flag', () => {
      const r = parseArgs(['--limit', '42'], {
        flags: { '--limit': { type: 'number' } },
      });
      assert.equal(r.flags['--limit'], 42);
    });

    it('honors flag default when not present', () => {
      const r = parseArgs([], {
        flags: { '--limit': { type: 'number', default: 50 } },
      });
      assert.equal(r.flags['--limit'], 50);
    });

    it('resolves short alias to canonical', () => {
      const r = parseArgs(['-t', 'T-7'], {
        flags: { '--task': { type: 'string', alias: '-t' } },
      });
      assert.equal(r.flags['--task'], 'T-7');
    });

    it('collects repeatable flags into an array', () => {
      const r = parseArgs(['--label', 'a', '--label', 'b'], {
        flags: { '--label': { type: 'string', repeatable: true } },
      });
      assert.deepEqual(r.flags['--label'], ['a', 'b']);
    });

    it('rejects unknown flag with exit code 2', () => {
      try {
        parseArgs(['--bogus'], { flags: {} });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err instanceof ArgparseError);
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /unknown flag: --bogus/);
      }
    });

    it('rejects flag missing its value', () => {
      assert.throws(
        () => parseArgs(['--task'], { flags: { '--task': { type: 'string' } } }),
        /requires a value/,
      );
    });

    it('rejects when next token is another flag (not a value)', () => {
      assert.throws(
        () => parseArgs(['--task', '--json'], {
          flags: {
            '--task': { type: 'string' },
            '--json': { type: 'boolean' },
          },
        }),
        /requires a value \(got next flag --json\)/,
      );
    });

    it('rejects non-numeric value for number flag', () => {
      assert.throws(
        () => parseArgs(['--limit', 'abc'], {
          flags: { '--limit': { type: 'number' } },
        }),
        /expects a number/,
      );
    });

    it('treats `--` as positional terminator', () => {
      const r = parseArgs(['--', '--looks-like-flag'], {
        positional: [{ name: 'tok', required: true }],
        flags: {},
      });
      assert.equal(r.positional.tok, '--looks-like-flag');
    });

    // P4 round-1 review fix #2 — boolean flags must NOT silently swallow the
    // next token if it looks like a boolean value. Previously
    // `--remove false` parsed as `--remove=true` with `false` consumed as
    // an extra positional that was then silently dropped — masking the
    // operator's intent to set --remove=false.
    it('rejects spaced boolean value (--flag false) with exit 2', () => {
      try {
        parseArgs(['--remove', 'false'], {
          flags: { '--remove': { type: 'boolean' } },
        });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err instanceof ArgparseError, `expected ArgparseError, got ${err}`);
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /boolean flag --remove does not accept a positional value: false/);
        assert.match(err.message, /use --remove=false/);
      }
    });

    it('rejects spaced boolean value (--flag true)', () => {
      assert.throws(
        () => parseArgs(['--json', 'true'], {
          flags: { '--json': { type: 'boolean' } },
        }),
        /boolean flag --json does not accept a positional value: true/,
      );
    });

    it('still accepts inline boolean false (--flag=false)', () => {
      const r = parseArgs(['--remove=false'], {
        flags: { '--remove': { type: 'boolean' } },
      });
      assert.equal(r.flags['--remove'], false);
    });

    it('boolean flag followed by non-boolean-looking token does NOT consume it', () => {
      // `--json --root somedir` should set --json=true and leave --root + somedir
      // as a normal flag pair. Regression guard: the new boolean trap is narrow.
      const r = parseArgs(['--json', '--root', 'somedir'], {
        flags: {
          '--json': { type: 'boolean' },
          '--root': { type: 'string' },
        },
      });
      assert.equal(r.flags['--json'], true);
      assert.equal(r.flags['--root'], 'somedir');
    });

    it('boolean flag followed by an arbitrary positional does NOT consume it', () => {
      // The narrow trap only fires for true|false|1|0|yes|no — anything else
      // (a stable_id, a filename, etc.) is left to the positional handler.
      const r = parseArgs(['--json', 'sess_abc'], {
        positional: [{ name: 'sid', required: true }],
        flags: { '--json': { type: 'boolean' } },
      });
      assert.equal(r.flags['--json'], true);
      assert.equal(r.positional.sid, 'sess_abc');
    });
  });

  describe('parseArgs — positional', () => {
    it('binds first positional to first slot', () => {
      const r = parseArgs(['sess_abc', 'my-alias'], {
        positional: [
          { name: 'stable_id', required: true },
          { name: 'alias', required: false },
        ],
      });
      assert.equal(r.positional.stable_id, 'sess_abc');
      assert.equal(r.positional.alias, 'my-alias');
      assert.deepEqual(r.positionalArray, ['sess_abc', 'my-alias']);
    });

    it('rejects when required positional missing', () => {
      try {
        parseArgs([], {
          positional: [{ name: 'stable_id', required: true }],
        });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err instanceof ArgparseError);
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /missing required positional: stable_id/);
      }
    });

    it('allows optional positional to be absent', () => {
      const r = parseArgs(['only-required'], {
        positional: [
          { name: 'a', required: true },
          { name: 'b', required: false },
        ],
      });
      assert.equal(r.positional.a, 'only-required');
      assert.equal(r.positional.b, undefined);
    });

    // P4 round-1 review fix #2 — extra positionals beyond the declared spec
    // were silently dropped. Now they exit 2 unless the spec opts in via
    // `restPositional: true`. Catches operator typos like
    // `tree <id> garbage` that previously rendered the tree without
    // surfacing the unused token.
    it('rejects extra positional args by default with exit 2', () => {
      try {
        parseArgs(['sess_abc', 'garbage'], {
          positional: [{ name: 'stable_id', required: true }],
        });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err instanceof ArgparseError, `expected ArgparseError, got ${err}`);
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /unexpected extra positional argument\(s\): garbage/);
      }
    });

    it('rejects multiple extra positionals (joins them into the message)', () => {
      assert.throws(
        () => parseArgs(['a', 'b', 'c', 'd'], {
          positional: [
            { name: 'one', required: true },
            { name: 'two', required: false },
          ],
        }),
        /unexpected extra positional argument\(s\): c d/,
      );
    });

    it('honors restPositional: true (allows arbitrary trailing positionals)', () => {
      const r = parseArgs(['cmd', 'x', 'y', 'z'], {
        positional: [{ name: 'cmd', required: true }],
        restPositional: true,
      });
      assert.equal(r.positional.cmd, 'cmd');
      assert.deepEqual(r.positionalArray, ['cmd', 'x', 'y', 'z']);
    });
  });

  describe('parseArgs — help', () => {
    it('-h triggers helpRequested', () => {
      const r = parseArgs(['-h'], {
        positional: [{ name: 'stable_id', required: true }],
      });
      assert.equal(r.helpRequested, true);
    });

    it('--help triggers helpRequested even when required positional missing', () => {
      // Help should short-circuit the required-positional check so users can
      // discover what arguments to pass.
      const r = parseArgs(['--help'], {
        positional: [{ name: 'stable_id', required: true }],
      });
      assert.equal(r.helpRequested, true);
    });
  });

  describe('formatHelp', () => {
    it('renders a usage line with flags and examples', () => {
      const out = formatHelp({
        usage: 'sessions-db find [--task X]',
        summary: 'Filter sessions.',
        flags: [
          { name: '--task <id>', desc: 'filter by task id' },
          { name: '--json', desc: 'JSON output' },
        ],
        examples: [
          'sessions-db find --task T-1',
        ],
      });
      assert.match(out, /^Usage: sessions-db find/);
      assert.match(out, /Filter sessions\./);
      assert.match(out, /--task <id> {2}filter by task id/);
      assert.match(out, /Examples:\n {2}sessions-db find --task T-1\n$/);
    });
  });
});
