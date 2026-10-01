# Content search cache

`search --content` / `--deep` reuse derived message text from unchanged
transcripts. Matching remains case-insensitive arbitrary substring matching,
including one-character and Chinese queries. Records stay separate, in their
original order; snippets use the same first-match extraction as before.
Metadata, history, state/source filters, result ordering and `--max-file-mb`
remain in the CLI's existing passes.

## Storage and recovery

The cache lives in `sessions-db-search-cache/` next to the resolved
`sessions-db.json`. It contains searchable transcript text in binary form and
should be treated as private session data. New directories use mode `0700`,
entries use `0600`. It can be deleted at any time; it is never a source of truth
and never appends database events. To bypass it for diagnosis:

```sh
DRUUMEN_SESSIONS_DB_SEARCH_CACHE=0 sessions-db search "query" --content --json
```

Each entry is keyed by the absolute transcript path. Its source fingerprint
includes device, inode, size, nanosecond mtime and ctime. Appends, completed
partial lines, truncation and replacements invalidate it. A second source stat
checks stability before returning a cache result or saving a newly scanned
entry. Changed files are rebuilt rather than incrementally tail-read.

Entries contain ordered `recordText()` strings, a format/extraction version,
and a SHA-256 payload checksum. Missing entries, unsupported versions, invalid
shapes, checksum failure and cache IO failures fall back to scanning the source.
Node V8 serialization is an internal disposable format; incompatible Node
versions simply miss the cache. `VERSION` must change if text extraction changes.

Cold scans still stop immediately at their first hit. Such an entry is marked
incomplete: a later query can reuse a prefix hit, but a prefix miss must scan the
source. Only a full scan reaching EOF can cache absence. Malformed JSONL lines
retain the original scanner's skip behavior; stream errors are never cached.

Limits are 8 MiB per serialized entry, 128 MiB total entries, and 1,024 entries.
Collection is bounded conservatively before serialization. Larger entries are
searched through the original streaming path. Old entries are evicted on writes;
warm hits do not enumerate the directory. A per-process budget snapshot and a
writer generation avoid re-scanning all cache entries on every cold file.

An exclusive cache-only lock protects budget eviction and atomic file replacement.
A busy lock skips filling the cache without waiting. The shared lock helper has
no stale-lock recovery: an abandoned `.write.lock` stops further cache population
until the lock or the disposable cache directory is removed; searching still
works. Successful writes clean up abandoned matching temporary files. The total
budget excludes the small generation/lock files and a transient atomic-write
temporary file of up to 8 MiB. Cache limits do not bound the size of one source
JSONL record, which retains the original readline behavior.

## Synthetic benchmark (2026-10-01)

Run `node __tests__/benchmarks/content-search.mjs`. The script creates and
removes its own temporary corpus and uses a temporary HOME. It reads no real
session files. Each measurement uses a separate Node process; time measures
content scanning, excluding Node startup and metadata/projection passes.

Measured on Node v22.14.0, macOS arm64: 64 files, 1,000 messages plus 1,000
non-searchable tool-output records per file, 127.71 MiB JSONL total. Half use
Claude records and half Codex records. Results below are medians of five runs;
RSS is the largest process peak among those runs. “Cold” means the derived cache
is absent, not that the OS filesystem cache is empty.

| Query | Cache off (ms) | Cold (ms) | Warm (ms) | Off / cold / warm peak RSS (MiB) | Derived entries (MiB) |
| --- | ---: | ---: | ---: | --- | ---: |
| Missing substring | 585.4 | 601.2 | 57.0 | 85.7 / 114.7 / 87.6 | 24.05 |
| First-message hit | 24.6 | 56.4 | 10.3 | 51.9 / 53.4 / 50.2 | 0.04 |
| Last-message Chinese hit | 561.6 | 588.5 | 56.3 | 83.1 / 115.0 / 86.0 | 24.05 |

Warm full scans were about 10× faster in this corpus; all warm cases opened
zero source files. Cold queries still parse JSONL and add cache serialization
and write costs. First-message cold hits added 31.8 ms across 64 files and were
2.3× slower than the already short original scan, although early exit still
avoided reading the suffix. Repeated first-message hits were faster. Cold full
scans had roughly 29–32 MiB extra peak RSS. These are synthetic measurements,
not a prediction for every transcript corpus or the surrounding web request.
Cache eviction, frequently changing files, and mixed queries hitting incomplete
prefixes reduce the benefit. Disk-discovery metadata parsing is unchanged.

## Verification

Unit tests mechanically prove cold early exit, complete warm misses without a
source open, incomplete warm misses reopening the source, message boundaries,
first snippets, malformed/partial lines, mutation invalidation, corrupt and old
cache recovery, IO failure handling, size/count limits and concurrent writes.
CLI tests compare full JSON output with cache disabled, cold and warm for both
sources, Chinese/short queries, limits, state/source/history options and disk
discovery, then run six population processes concurrently.

The existing `--include-history` pass does not apply `--source`; this pre-existing
behavior is preserved by this optimization and should be addressed separately.
