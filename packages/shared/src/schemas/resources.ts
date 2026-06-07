/**
 * Resource Management API wire shapes (issue #163 and prior).
 *
 * Extracted from the main `schemas/index.ts` barrel when that file
 * crossed the project's 800-line ceiling. All schemas re-export from
 * the barrel so consumers continue importing from `@hashhive/shared`
 * unchanged - this is a structural split, not a public-API change.
 *
 * Per AGENTS.md: wire shapes live in `@hashhive/shared` as `z.infer`
 * from Zod schemas. Used by both backend route handlers (zValidator +
 * handler bodies) and frontend hooks (TanStack Query type narrowing).
 */

import '../openapi-extension.js'
import { z } from 'zod'

export const hashCandidateSchema = z
  .object({
    name: z.string(),
    hashcatMode: z.number().int(),
    category: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .openapi('HashCandidate')

/**
 * Shape of the JSONB written to `hash_lists.statistics` by the
 * hash-list parser worker (and merged with live counts by the dashboard
 * GET /hash-lists/:id route).
 */
export const hashListStatisticsSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    crackedCount: z.number().int().nonnegative(),
    crackRate: z.number().min(0).max(1),
    lastUpdated: z.string().datetime().optional(),
  })
  .openapi('HashListStatistics')

/**
 * Legacy JSON body for `POST /api/v1/dashboard/resources/hash-lists`
 * (create-empty path). Multipart one-shot uploads are validated inline
 * in the route because Hono's zValidator binds per content-type.
 */
export const createHashListRequestSchema = z
  .object({
    name: z.string().min(1).max(255),
    hashTypeId: z.number().int().positive().optional(),
    source: z.string().max(50).optional(),
  })
  .openapi('CreateHashListRequest')

/**
 * Request body for `POST /api/v1/dashboard/resources/detect-hash-type`.
 * Capped at 100 hashes per call to bound CPU on the synchronous regex
 * matcher in `hash-analysis.ts`.
 */
export const detectHashTypeRequestSchema = z
  .object({
    hashes: z.array(z.string().min(1).max(1024)).min(1).max(100),
  })
  .openapi('DetectHashTypeRequest')

/**
 * Response from `POST /api/v1/dashboard/resources/detect-hash-type`.
 * One entry per input hash; candidates ordered by confidence DESC.
 */
export const detectHashTypeResponseSchema = z
  .object({
    results: z.array(
      z.object({
        hashValue: z.string(),
        candidates: z.array(hashCandidateSchema),
      })
    ),
  })
  .openapi('DetectHashTypeResponse')

/**
 * Payload shape of `resource_update` events emitted by the hash-list
 * parser worker. Discriminated on `action` so subscribers can switch on
 * the terminal-state branch.
 *
 * `projectId` is carried in the inner payload as defense-in-depth: the
 * outer WS frame envelope is already project-scope-filtered in
 * `useEvents`, but inner-payload `projectId` lets `routeEvent` and any
 * future per-row update path validate ownership without re-reading
 * frame state. Hash list IDs are global integers, so a future caller
 * that keys off `hashListId` alone could otherwise act on a wrong-
 * project record if the outer filter ever drifted.
 */
export const resourceUpdateEventDataSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('hash_list_ready'),
    projectId: z.number().int().positive(),
    hashListId: z.number().int().positive(),
    statistics: hashListStatisticsSchema,
  }),
  z.object({
    action: z.literal('hash_list_failed'),
    projectId: z.number().int().positive(),
    hashListId: z.number().int().positive(),
    // Operator-facing error message. Bounded to catch a producer bug
    // that sets it to "" (the original schema allowed empty strings)
    // and to keep a hostile/log-bomb producer from spamming the wire.
    error: z.string().min(1).max(2000),
  }),
])

/**
 * Canonical resource lifecycle status. `pending` is the initial state
 * for generic resources (wordlist/rulelist/masklist rows before any
 * file is attached); `uploading` covers in-flight direct or chunked
 * upload; `uploaded` is the brief hash-list-only state after the file
 * lands but before the parser worker picks it up; `processing` is the
 * hash-list parsing phase; `ready` is the terminal success state;
 * `error` is the terminal failure state (matches the value written
 * by `hash-list-parser.ts` and `services/resources.ts`). Generic
 * resources flip `pending` → `uploading` → `ready` and skip the parse
 * states.
 */
export const resourceStatusSchema = z.enum([
  'pending',
  'uploading',
  'uploaded',
  'processing',
  'ready',
  'error',
])

/**
 * JSONB shape of `file_ref` columns on hash_lists / word_lists /
 * rule_lists / mask_lists. Source of truth for the storage handler in
 * `uploadHashListFile` / `uploadResourceFile`, mirrored here so the
 * frontend can narrow the row's `fileRef` without `as` casts.
 *
 * The column has three observable states:
 *   1. `{}` (the DB column default) before any upload starts.
 *   2. `{ bucket, key, contentType }` after `initiateChunkedUpload`
 *      but before the upload completes (in-progress).
 *   3. The full set including `size`, `name`, `uploadedAt` after
 *      upload completion.
 *
 * `bucket` is the S3 (or compat) bucket name at upload time so a
 * future bucket migration doesn't break old download URL generation.
 * `key` is the S3 object key. `size` is the byte count (also surfaced
 * at top-level `fileSize` for generic resources). `name` is the
 * operator-supplied filename for display only. `uploadedAt` is the
 * ISO timestamp at completion.
 */
export const fileRefSchema = z
  .object({
    bucket: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    contentType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    name: z.string().optional(),
    // ISO 8601 datetime - matches `hashListStatisticsSchema.lastUpdated`.
    uploadedAt: z.string().datetime().optional(),
  })
  .openapi('FileRef')

/**
 * Request body for `PATCH /api/v1/dashboard/resources/hash-lists/{id}`.
 * Sets the hash type on an existing hash list - used by the detect-
 * hash-type modal's "Use This Type" action after the operator picks a
 * candidate. Project scope is derived from the authenticated session,
 * not the request body.
 */
export const setHashListTypeRequestSchema = z
  .object({
    hashTypeId: z.number().int().positive(),
  })
  .openapi('SetHashListTypeRequest')

// ─── Frontend wire response shapes (JSON-serialized) ────────────────
//
// These represent the over-the-wire (JSON, dates-as-strings) shapes
// the frontend hooks deserialize from the dashboard routes. The
// backend route response schemas currently use `z.array(z.unknown())`
// for these surfaces — these schemas are the source of truth on the
// consumer side until the routes adopt them, and the frontend hooks
// infer types from them so the AGENTS.md rule
// "no local cross-boundary interfaces in packages/frontend/src/hooks/*"
// is satisfied.

/**
 * Wire shape of a hash type catalog row returned from
 * `GET /dashboard/resources/hash-types`. Mirrors the `hash_types`
 * table's serialized projection.
 */
export const hashTypeWireSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    hashcatMode: z.number().int().nonnegative(),
    category: z.string(),
  })
  .openapi('HashTypeWire')

/**
 * Wire shape of a hash list row returned from
 * `GET /dashboard/resources/hash-lists`. The current `listHashLists`
 * service selects directly from `hash_lists` with no `hash_items`
 * join, so `hashCount` and `crackedCount` are not projected today;
 * the fields remain optional so a future aggregating sweep can
 * surface them without an API break. Consumers default-zero them.
 */
export const hashListWireSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    projectId: z.number().int().positive(),
    hashTypeId: z.number().int().positive().nullable(),
    hashCount: z.number().int().nonnegative().optional(),
    crackedCount: z.number().int().nonnegative().optional(),
    status: resourceStatusSchema,
    fileRef: fileRefSchema.nullable(),
    createdAt: z.string(),
  })
  .openapi('HashListWire')

/**
 * Wire shape of a generic resource row (wordlist / rulelist /
 * masklist) returned from `GET /dashboard/resources/{type}`.
 * `fileSize` is the row's top-level byte count column; the JSONB
 * `fileRef.size` mirrors it after upload.
 */
export const resourceWireSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    projectId: z.number().int().positive(),
    status: resourceStatusSchema,
    fileSize: z.number().int().nonnegative().nullable(),
    fileRef: fileRefSchema.nullable(),
    createdAt: z.string(),
  })
  .openapi('ResourceWire')

/**
 * Wire shape of a hash list detail row returned from
 * `GET /dashboard/resources/hash-lists/{id}`. Extends the list shape
 * with the parsed statistics payload.
 */
export const hashListDetailWireSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    projectId: z.number().int().positive(),
    hashTypeId: z.number().int().positive().nullable(),
    status: resourceStatusSchema,
    statistics: hashListStatisticsSchema,
    createdAt: z.string(),
  })
  .openapi('HashListDetailWire')

/**
 * Wire shape of a hash item row returned from
 * `GET /dashboard/resources/hash-lists/{id}/items`. Timestamps are
 * ISO strings; `plaintext` and `crackedAt` are null when uncracked.
 */
export const hashItemWireSchema = z
  .object({
    id: z.number().int().positive(),
    hashValue: z.string(),
    plaintext: z.string().nullable(),
    crackedAt: z.string().nullable(),
    agentId: z.number().int().positive().nullable(),
  })
  .openapi('HashItemWire')

/**
 * Wire shape of the paginated hash items response returned from
 * `GET /dashboard/resources/hash-lists/{id}/items`. Limit / offset
 * are echoed back so the client can compute pagination state without
 * tracking the request shape separately.
 */
export const hashItemsPageWireSchema = z
  .object({
    items: z.array(hashItemWireSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('HashItemsPageWire')
