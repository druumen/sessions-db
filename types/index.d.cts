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
 *
 * That "identical" is a claim, not a mechanism — tsc emits `.d.mts`
 * from `lib/` and never touches this file, so it is maintained by
 * hand and it HAS drifted: 0.3.0 added five name-model type names to
 * `index.d.ts` and not here, leaving the CJS consumer this file exists
 * to serve unable to import any of them. Two checks now stand behind
 * the claim, both in `__tests__/types-smoke/`:
 * `cockpit-require.cts` compiles a real CJS consumer against THIS
 * file, and `types-smoke.test.mjs` diffs the two export lists directly
 * so a name added to one and not the other fails immediately rather
 * than at some consumer's next install.
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
  // Names (0.3.0) — channel/source are open strings by contract, see lib/names.mjs
  NameChannel,
  NameSource,
  SessionName,
  NameHistoryEntry,
  ResolvedDisplayName,
  // Composite shapes
  TranscriptFile,
  IdentityResolution,
  ParentCandidate,
  KnownSession,
  ProjectionMeta,
  Projection,
  SessionEvent,
} from './types.d.mts';
