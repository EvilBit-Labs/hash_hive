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

import { hashListTypeAnalysisSchema } from './hash-lists.js'

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
 *
 * `splitOutcome` (issue #202, code review fix) is written ONLY on a split
 * PARENT hash list, and only for the two degenerate `runSplitAnalysis`
 * outcomes that create no `hash_lists` children row
 * (`queue/workers/hash-list-split.ts`): `'empty'` (no crackable items) and
 * `'single_group'` (every item classifies to one group, nothing to split).
 * This is the durable signal `getSplitStatus`
 * (`services/campaign-split-status.ts`) falls back to once the BullMQ job
 * that produced the outcome is evicted past its retention window — without
 * it, a degenerate outcome with an evicted job reads as `pending` forever,
 * since neither signal `getSplitStatus` normally reads (children rows /
 * live job state) exists for these two outcomes. Optional and absent on
 * every non-split-parent list and on a split parent that hasn't run
 * degenerate analysis.
 */
export const hashListStatisticsSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    crackedCount: z.number().int().nonnegative(),
    crackRate: z.number().min(0).max(1),
    lastUpdated: z.string().datetime().optional(),
    splitOutcome: z.enum(['empty', 'single_group']).optional(),
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
 * Live cracked/total rollup across a split parent's mode-bearing
 * sub-campaigns only (issue #202, SU5). Deliberately excludes needs-type
 * children (no sub-campaign targets them) so the denominator never
 * includes hashes nobody has assigned a crackable type to yet - see
 * `subCampaignProgressWireSchema`'s doc comment for the full contract.
 */
export const subCampaignHashProgressWireSchema = z
  .object({
    total: z.number().int().nonnegative(),
    cracked: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    percentage: z.number().min(0).max(1),
  })
  .openapi('SubCampaignHashProgress')

/**
 * Aggregated progress across a split parent hash list's mode-bearing
 * sub-campaigns (issue #202, SU5). A split parent campaign has no attacks
 * or tasks of its own - all cracking happens on its children
 * (`campaigns.parentCampaignId`) - so this is computed on READ by
 * combining each sub-campaign's own already-computed `progress` JSONB
 * (`getHashListSplitProgress` in
 * `packages/backend/src/services/hash-items/split-progress.ts`), not
 * derived from the parent campaign's row.
 *
 * `done` is true only when EVERY sub-campaign counted here has reached
 * `completed` AND `pendingSubCampaignCount` is zero - needs-type children
 * have no sub-campaign at all, so they are excluded from both
 * `subCampaignCount` and `done` by construction, not by a separate filter.
 * This is what lets an otherwise-complete parent read as done even while
 * `HashListDetailWire.needsTypeCount` is still nonzero.
 *
 * `pendingSubCampaignCount` (code review fix, #202) counts mode-bearing
 * (resolved, `verdict: 'homogeneous'`) children that have NO sub-campaign
 * linked yet - the signature of a `confirmSplitCampaign` crash between
 * flipping a child's `type_analysis` to `homogeneous` and creating its
 * sub-campaign (that flow is not a single atomic transaction). A nonzero
 * value here forces `done` to `false` even when every sub-campaign that
 * DOES exist has completed, so a partially-confirmed split can't read as
 * finished.
 */
export const subCampaignProgressWireSchema = z
  .object({
    subCampaignCount: z.number().int().nonnegative(),
    completedSubCampaignCount: z.number().int().nonnegative(),
    done: z.boolean(),
    totalTasks: z.number().int().nonnegative(),
    completedTasks: z.number().int().nonnegative(),
    tasksFailed: z.number().int().nonnegative(),
    overallProgress: z.number().min(0).max(1),
    hashProgress: subCampaignHashProgressWireSchema.nullable(),
    pendingSubCampaignCount: z.number().int().nonnegative(),
  })
  .openapi('SubCampaignProgress')

/**
 * Wire shape of a hash list detail row returned from
 * `GET /dashboard/resources/hash-lists/{id}`. Extends the list shape
 * with the parsed statistics payload.
 *
 * `typeAnalysis` mirrors the nullable `hash_lists.type_analysis` jsonb
 * column (foundation toward #202): `null` for a legacy list that
 * predates the analysis feature or hasn't been (re-)ingested yet,
 * otherwise the persisted `HashListTypeAnalysis` computed during
 * ingestion. The route (`getHashListRoute` in
 * `packages/backend/src/routes/dashboard/resources.ts`) projects the
 * full DB row onto the wire via spread, so this field requires no
 * additional route-level mapping - it rides along with `hashTypeId`
 * and `status`.
 *
 * `needsTypeCount` / `subCampaignProgress` (#202, SU5) are ONLY present
 * for a split PARENT hash list (one with children via
 * `hash_lists.parent_hash_list_id`) - both are `optional()` so a normal
 * (never-split) list's response omits them entirely rather than sending
 * `null`, keeping the existing wire shape byte-for-byte unchanged for the
 * common case. `needsTypeCount` is the number of hash-item ENTRIES (not
 * groups) sitting in children that still need a type assigned before they
 * can crack (`type_analysis.verdict === 'needs-review'` and no
 * sub-campaign targets them yet) - deliberately kept OUT of `statistics`
 * and `subCampaignProgress` so a parent with unresolved needs-type
 * children doesn't read as stalled once every mode-bearing sub-campaign
 * has actually finished.
 */
export const hashListDetailWireSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    projectId: z.number().int().positive(),
    hashTypeId: z.number().int().positive().nullable(),
    status: resourceStatusSchema,
    statistics: hashListStatisticsSchema,
    typeAnalysis: hashListTypeAnalysisSchema.nullable(),
    needsTypeCount: z.number().int().nonnegative().optional(),
    subCampaignProgress: subCampaignProgressWireSchema.nullable().optional(),
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
