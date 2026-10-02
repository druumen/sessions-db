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
partial lines, truncation and replacements normally invalidate it quickly.
Metadata is only a rejection shortcut: equal stat fields do not prove equal
contents. Format v2 stores a SHA-256 digest and byte count for the exact raw
chunks used by the cold scanner. A warm complete entry rereads and hashes the
whole source; a warm prefix hit hashes only its saved byte range. A second stat
checks for concurrent changes before returning a cached result or saving an
entry. Changed files are rebuilt rather than incrementally tail-read.

Entries contain ordered `recordText()` strings, a format/extraction version,
a SHA-256 cache-payload checksum, and a separate source-content digest. Missing
entries, v1 entries, invalid shapes, either checksum failure and cache IO
failures fall back to scanning the source.
Node V8 serialization is an internal disposable format; incompatible Node
versions simply miss the cache. `VERSION` must change if text extraction changes.

Cold scans still stop immediately at their first hit. Such an entry is marked
incomplete: a later query can reuse a prefix hit, but a prefix miss must scan the
source. Only a full scan reaching EOF can cache absence. Malformed JSONL lines
retain the original scanner's skip behavior; stream errors are never cached.
Hashing runs before readline decodes the same binary chunks, including split
UTF-8 sequences. Cold scanning never rereads the source to compute a digest.
The saved prefix may include read-ahead bytes in the first-hit chunk; validating
that range is conservative and does not extend a cold scan to EOF. Warm checks
reread bytes without JSON parsing. As with ordinary streaming search, the source
is not locked into a filesystem snapshot while a concurrent writer is active.

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

## Validity regression and verification (2026-10-02)

GitLab jobs [120948](https://gitlab.tinfant.org/druumen/sessions-db/-/jobs/120948)
and [120949](https://gitlab.tinfant.org/druumen/sessions-db/-/jobs/120949), on
MR !22 head `4b747353` with `node:20-bookworm`, failed the original cache unit
test at line 116: after an equal-length rewrite with restored mtime, a complete
entry returned `truncated target` instead of `rewritten target`. The test file
has no diff between that MR head and master `5ecda7ad`. v1 incorrectly treated
matching stat metadata as sufficient evidence; filesystem timestamps can collide.

The regression tests deterministically simulate all matching stat fields by
rewriting the old cache entry's metadata stamp to the changed source's actual
stamp while preserving its old source digest. Both complete and prefix entries
must detect a middle rewrite, return the updated first snippet for the same
query, and find newly introduced substrings. No timestamp waits are used.

Run `node __tests__/benchmarks/cache-validity-negative-control.mjs` for the
negative control. It creates temporary code copies and selectively bypasses
only the complete or prefix digest comparison while retaining byte reads/count
checks. Each mutation gives 13 unit tests: 12 pass and its one corresponding
forced-fingerprint test fails; removing that bearing test gives 12 passes and
zero failures. Both cases have been verified.

The remaining unit coverage proves early exit, warm binary verification without
JSON parsing, incomplete misses scanning the source, malformed lines, UTF-8
code points split across chunks and at the saved prefix boundary, first snippets,
cache corruption/version recovery, source IO failures, and size/count bounds.
CLI tests compare complete JSON with cache off/cold/warm and run six concurrent
population processes. Final suites passed on macOS Node 22.14.0 and Linux
Node 20.20.2: 898 passed, zero failed, three existing TypeScript checks skipped
because `tsc` was not installed. Linux used a disposable container with a writable
copy of this checkout and synthetic temporary HOME; no dependencies were installed.

## Synthetic benchmark (v2, 2026-10-02)

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
| Missing substring | 583.2 | 635.0 | 193.1 | 92.5 / 112.3 / 113.8 | 24.06 |
| First-message hit | 24.4 | 55.7 | 27.7 | 51.9 / 53.5 / 53.5 | 0.05 |
| Last-message Chinese hit | 564.7 | 626.8 | 180.5 | 84.8 / 114.7 / 110.7 | 24.06 |

All v2 warm cases reopen 64 source files to verify bytes. Full and late-hit cases
reread 127.71 MiB; first-message cases verify 4 MiB of saved read-ahead prefixes.
Warm JSON parse count is zero, compared with 128,000 records for an uncached
miss, 127,936 for an uncached late hit and 64 for first-message hits. Cold queries
still parse JSONL and add hashing, cache serialization and write costs. These
are synthetic measurements, not a prediction for every transcript corpus or
the surrounding web request.
Warm missing/late-hit scans were about 3.0–3.1× faster than uncached scanning.
First-message warm hits were slightly slower (3.3 ms across 64 files); cold
first-message hits added 31.3 ms. Warm full-scan peak RSS was about 21–26 MiB
higher than the uncached scanner. The optimization saves JSON extraction work,
not source IO, and does not improve every query shape.
Cache eviction, frequently changing files, and mixed queries hitting incomplete
prefixes reduce the benefit. Disk-discovery metadata parsing is unchanged.

The previous v1 measurements (2026-10-01: roughly 10× faster warm full scans and
zero source opens) described the unsafe metadata-only implementation. They do
not apply to v2, which trades source IO for reliable content validation.

The existing `--include-history` pass does not apply `--source`; this pre-existing
behavior is preserved by this optimization and should be addressed separately.
