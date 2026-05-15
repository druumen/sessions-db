/**
 * @druumen/sessions-db — public TypeScript entry point for CJS consumers.
 *
 * This is the `.d.cts` sibling of `./index.d.ts`. Both have the same
 * value + type re-export shape; the only difference is the extension,
 * which tells TypeScript Node16/NodeNext module resolution that the
 * underlying runtime module is CJS.
 *
 * Without this file, a consumer with `moduleResolution: "Node16"` in
 * a CJS context (no `"type": "module"` in their package.json) hits
 * `TS1479` because the Node16 resolver picks the `import` condition's
 * `.d.mts` types — which TS treats as "ESM origin" — and refuses to
 * `require()` them from CJS.
 *
 * `package.json` exports map nests `types` per runtime condition:
 *
 *     "exports": {
 *       ".": {
 *         "import": { "types": "./types/index.d.ts",  ... },
 *         "require": { "types": "./types/index.d.cts", ... }
 *       }
 *     }
 *
 * This was added in 0.1.1 as part of the cockpit B1 packaging fix.
 *
 * NOTE on file content: identical to `index.d.ts` except for the
 * extension. The runtime IS bundled into a single `lib/index.cjs`
 * (esbuild) so type signatures match across both .d.mts re-exports
 * (ESM source paths) and the .cjs bundle (which contains the same
 * symbols).
 */

// Runtime VALUES (functions + constants) + their inferred TypeScript types,
// from the auto-emitted mirror of `lib/index.mjs`. Same source-of-truth as
// the .d.ts barrel; the .cts extension flips TS's runtime-origin assumption
// to CJS, matching the actual `lib/index.cjs` bundle that the require()
// condition resolves at runtime.
export * from './index.d.mts';

// TYPE NAMES (branded scalars, enums, composite shapes), from the
// auto-emitted mirror of `lib/types.mjs`'s @typedef block.
export type {
  // Branded scalars
  SessionStableId,
  ClaudeSessionId,
  EventId,
  Iso8601,
  // Enums
  ActivityState,
  Outcome,
  IdentitySource,
  IdentityConfidence,
  EventOp,
  // Composite shapes
  TranscriptFile,
  IdentityResolution,
  ParentCandidate,
  KnownSession,
  ProjectionMeta,
  Projection,
  SessionEvent,
} from './types.d.mts';
