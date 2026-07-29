/**
 * SuperHashlist wire shapes (issue #101 — U7).
 *
 * A SuperHashlist is a named, read-time union over several member hash lists
 * (KTD5). These are the request/response contracts for the dashboard (U8) and
 * control (U9) management surfaces; the service layer
 * (`packages/backend/src/services/super-hash-lists.ts`) produces the row data
 * these shapes serialize.
 *
 * Per AGENTS.md, wire shapes cross the API boundary and MUST live in
 * `@hashhive/shared` as `z.infer` from Zod schemas — never as local backend or
 * frontend interfaces. Re-exported from `schemas/index.ts`; the `z.infer` types
 * are exported from `types/index.ts`.
 */

import '../openapi-extension.js'
import { z } from 'zod'

// Name bounds mirror `super_hash_lists.name varchar(255)` in the schema.
export const SUPER_NAME_MAX_LEN = 255

/**
 * Base wire shape for a SuperHashlist entity — the columns of
 * `super_hash_lists`. Timestamps serialize to ISO-8601 strings over JSON
 * (Drizzle `Date` does not survive JSON); `archivedAt` is `null` while the
 * super is active. This shape carries NO hash-item columns (R10) — a super
 * owns no items.
 */
export const superHashListWireSchema = z
  .object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    name: z.string().min(1).max(SUPER_NAME_MAX_LEN),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('SuperHashList')

/**
 * Detail wire shape — the entity plus its member hash-list ids (the union's
 * membership, R2/R4). Returned by `GET /{id}`, `POST /` (create), and the
 * membership mutations (`POST /{id}/members`, `DELETE /{id}/members/{listId}`)
 * so a client can render membership without a second round-trip. Rename and
 * archive do NOT return this shape - see `superHashListResponseSchema` below.
 */
export const superHashListDetailWireSchema = superHashListWireSchema
  .extend({
    memberIds: z.array(z.number().int().positive()),
  })
  .openapi('SuperHashListDetail')

/**
 * `POST /super-hash-lists` request body. `memberIds` is optional and may be
 * empty or a single id: the minimum-of-two-members invariant (R2) is enforced
 * at campaign-target time (U10), NOT at create time, so a super can be built
 * up incrementally in the UI (plan Open Question — "Minimum member count
 * enforcement point"). Duplicate ids are collapsed by the service.
 */
export const createSuperRequestSchema = z
  .object({
    name: z.string().min(1).max(SUPER_NAME_MAX_LEN),
    memberIds: z.array(z.number().int().positive()).max(1000).optional(),
  })
  .openapi('CreateSuperHashListRequest')

/** `PATCH /super-hash-lists/{id}` request body — rename only. */
export const renameSuperRequestSchema = z
  .object({
    name: z.string().min(1).max(SUPER_NAME_MAX_LEN),
  })
  .openapi('RenameSuperHashListRequest')

/**
 * `POST /super-hash-lists/{id}/members` request body — the hash list to add to
 * the super's membership.
 */
export const addSuperMemberRequestSchema = z
  .object({
    hashListId: z.number().int().positive(),
  })
  .openapi('AddSuperHashListMemberRequest')

/**
 * Dashboard list envelope (`GET /super-hash-lists`). Carries `limit`/`offset`
 * pagination per the dashboard surface's pagination contract; `total` is the
 * full matching count regardless of the page window. The control surface (U9)
 * wraps the same `superHashListWireSchema` rows in its own offset/limit
 * envelope at the route layer.
 */
export const superHashListListResponseSchema = z
  .object({
    superHashLists: z.array(superHashListWireSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('SuperHashListListResponse')

/**
 * Single-entity envelope for the mutations whose service call returns a bare
 * `super_hash_lists` row without membership — rename (`PATCH /{id}`) and
 * archive (`POST /{id}/archive`). Deliberately NOT the detail shape: those
 * service functions do not read the join table, so promising `memberIds` here
 * would mean the route derives a field the service never produced.
 */
export const superHashListResponseSchema = z
  .object({
    superHashList: superHashListWireSchema,
  })
  .openapi('SuperHashListResponse')

/**
 * Single-entity envelope carrying membership — returned by create
 * (`POST /`), detail (`GET /{id}`), and the membership mutations
 * (`POST /{id}/members`, `DELETE /{id}/members/{listId}`), all of which are
 * backed by service functions that return `SuperHashListWithMembers`.
 */
export const superHashListDetailResponseSchema = z
  .object({
    superHashList: superHashListDetailWireSchema,
  })
  .openapi('SuperHashListDetailResponse')
