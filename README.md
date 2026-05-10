# @druumen/sessions-db

Cross-session traceability for Claude Code.

## Installation

```bash
npm install @druumen/sessions-db
```

## Library API

(filled Day 3)

## CLI

(filled Day 5)

## Hook Setup

(filled Day 5)

## Path Resolution

(filled Day 4)

## Privacy

sessions-db stores Claude Code session metadata locally. No network
egress. The `first_prompt_preview` field stores a sanitized 200-char
excerpt of the first user message; can be disabled via
`opts.storeFirstPrompt: false` or `DRUUMEN_SESSIONS_DB_STORE_PREVIEW=0`
env var.

(detailed Day 5 with marketplace audit prep)

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Roadmap

- 0.1.0: Library + CLI + hook (current)
- 0.2.0: Multi-machine sync (TBD)
- 0.3.0: Web UI (TBD)
