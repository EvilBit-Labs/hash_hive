/**
 * Apply the `@asteasolutions/zod-to-openapi` prototype extension to
 * this package's own `z` instance.
 *
 * Why this lives in `@hashhive/shared`: Bun stores each dep version
 * under a content-hashed subpath in `node_modules/.bun/`, so
 * `@hono/zod-openapi` and `@hashhive/shared` end up holding two
 * distinct `z` module instances even when both resolve to the same
 * zod version. The extension `extendZodWithOpenApi(z)` patches the
 * prototype of *its caller's* z instance — patching from inside
 * `@hono/zod-openapi` does not reach the prototype objects backing
 * schemas built in `@hashhive/shared`. Calling the extension here, in
 * shared, against shared's own `z` import, is what makes
 * `sharedSchema.openapi('Name')` work in route files.
 *
 * Imported as a side effect from `schemas/index.ts` BEFORE any schema
 * construction so every exported Zod schema has `.openapi()` available
 * at the call site.
 *
 * Frontend bundle cost: `@asteasolutions/zod-to-openapi` is a small
 * standalone package; importing only `extendZodWithOpenApi` (no
 * generators) keeps the tree-shaken footprint minimal. The extension
 * adds prototype methods that are no-ops unless called, so frontend
 * code that never invokes `.openapi()` pays only the static module
 * cost.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)
