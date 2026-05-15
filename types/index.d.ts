/**
 * @druumen/sessions-db — public TypeScript entry point (hand-crafted barrel).
 *
 * Stitches together the two files that `tsc --emitDeclarationOnly` produces
 * from the JS source so consumers get one curated import surface:
 *
 *   - `./index.d.mts` — value re-exports mirroring `lib/index.mjs` (run-
 *     time functions + constants, with their TypeScript type signatures).
 *   - `./types.d.mts` — type declarations lifted from the `@typedef`
 *     block in `lib/types.mjs` (branded scalars, enums, composite shapes).
 *
 * Two files exist because `lib/index.mjs` is plain JS — it can re-export
 * runtime symbols but not `export type` (TypeScript-only syntax). This
 * file does the type-side stitching that JS cannot.
 *
 * `package.json` `"types"` and `exports[".".types]` both point here.
 * `tsc` never overwrites this file — it emits `.d.mts` for `.mjs`
 * sources, so the `.d.ts` extension keeps it out of the build path.
 *
 * Cockpit / consumer pattern:
 *
 *     import {
 *       loadProjection,         // runtime value
 *       setAlias,               // runtime value
 *       type KnownSession,      // type
 *       type Projection,        // type
 *     } from '@druumen/sessions-db';
 *
 * This barrel was added in 0.1.1 to fix Bug B from 0.1.0, where the
 * previous hand-crafted file used `export type X = typeof import('...')`
 * patterns that re-exported type aliases instead of values, breaking
 * `import { loadProjection }` for cockpit-class consumers under Node16.
 */

// Runtime VALUES (functions + constants) + their inferred TypeScript types,
// from the auto-emitted mirror of `lib/index.mjs`.
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
