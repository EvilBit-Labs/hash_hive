/**
 * Campaign-wizard split + review flow wire shapes (issue #202, unit SU3/SU7).
 *
 * `POST /api/v1/dashboard/campaigns` against a mixed/needs-review hash list
 * enqueues the async split analysis job and returns 202
 * `{ splitPending: true, hashListId }` (unless the parent was already split,
 * in which case it returns `SplitReviewGroups` at 200 the same as before).
 * The wizard then polls `GET /api/v1/dashboard/campaigns/split/status/{hashListId}`
 * (`SplitStatusResponse`) until the job resolves:
 *   - `ready` — children exist; `reviewGroups` is populated. The caller
 *     resolves the `ambiguous` groups' candidate modes and posts
 *     `ConfirmSplitCampaignRequest` to `POST /campaigns/split/confirm`,
 *     which creates the parent campaign plus one single-mode sub-campaign
 *     per resolved sub-list (`ConfirmSplitCampaignResponse`).
 *   - `empty` — the list has no crackable items; the wizard surfaces `message`
 *     as an error.
 *   - `single_group` — the split classifier found nothing to split despite
 *     the mixed verdict; the wizard re-submits `POST /campaigns` with
 *     `skipSplit: true` to fall back to a plain single-mode campaign on the
 *     original list.
 *   - `failed` — the job errored; `message` carries the failure reason.
 *   - `pending` — still queued/running; the wizard keeps polling.
 */
import '../openapi-extension.js'
import { z } from 'zod'

export const splitReviewConfidentGroupSchema = z
  .object({
    id: z.number().int().positive(),
    mode: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('SplitReviewConfidentGroup')

export const splitReviewAmbiguousGroupSchema = z
  .object({
    id: z.number().int().positive(),
    // An ambiguous group is ambiguous BECAUSE the type-detection classifier
    // found 2+ tied-confidence candidate modes for it — by construction it
    // can never have fewer than 2 (code review fix: a single-candidate
    // "ambiguous" group would be a classifier bug, not a valid wire shape).
    candidateModes: z.array(z.number().int().nonnegative()).min(2),
    itemCount: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('SplitReviewAmbiguousGroup')

export const splitReviewUnidentifiedGroupSchema = z
  .object({
    id: z.number().int().positive(),
    itemCount: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('SplitReviewUnidentifiedGroup')

export const splitReviewGroupsSchema = z
  .object({
    parentHashListId: z.number().int().positive(),
    confident: z.array(splitReviewConfidentGroupSchema),
    ambiguous: z.array(splitReviewAmbiguousGroupSchema),
    unidentified: z.array(splitReviewUnidentifiedGroupSchema),
  })
  .strict()
  .openapi('SplitReviewGroups')

export const splitAssignmentRequestSchema = z
  .object({
    subListId: z.number().int().positive(),
    mode: z.number().int().nonnegative(),
  })
  .openapi('SplitAssignment')

export const confirmSplitCampaignRequestSchema = z
  .object({
    parentHashListId: z.number().int().positive(),
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    priority: z.number().int().min(1).max(10).optional(),
    assignments: z.array(splitAssignmentRequestSchema),
  })
  .openapi('ConfirmSplitCampaignRequest')

export const resolvedSubCampaignSchema = z
  .object({
    id: z.number().int().positive(),
    hashListId: z.number().int().positive(),
    mode: z.number().int().nonnegative(),
    parentCampaignId: z.number().int().positive(),
  })
  .strict()
  .openapi('ResolvedSubCampaign')

export const confirmSplitCampaignResponseSchema = z
  .object({
    parentCampaignId: z.number().int().positive(),
    parentHashListId: z.number().int().positive(),
    subCampaigns: z.array(resolvedSubCampaignSchema),
  })
  .strict()
  .openapi('ConfirmSplitCampaignResponse')

// ─── Async split status polling (issue #202 SU7) ────────────────────────

export const splitPendingResponseSchema = z
  .object({
    splitPending: z.literal(true),
    hashListId: z.number().int().positive(),
  })
  .strict()
  .openapi('SplitPendingResponse')

export const splitStatusLiteralSchema = z.enum([
  'pending',
  'ready',
  'failed',
  'empty',
  'single_group',
])

// Discriminated on `status` (mirrors `resourceUpdateEventDataSchema`'s wire
// pattern) rather than a single flat object with `reviewGroups` nullable
// across every status. The real invariant is `reviewGroups` non-null IFF
// `status === 'ready'` — a flat shape lets any status carry any
// `reviewGroups` value, so callers had to defensively re-check
// `status === 'ready' && reviewGroups` even though the server never sends
// the other combination (code review fix).
const splitStatusReadySchema = z
  .object({
    status: z.literal('ready'),
    reviewGroups: splitReviewGroupsSchema,
    message: z.string().nullable(),
  })
  .strict()
  .openapi('SplitStatusReady')

const splitStatusPendingSchema = z
  .object({
    status: z.literal('pending'),
    reviewGroups: z.null(),
    message: z.string().nullable(),
  })
  .strict()
  .openapi('SplitStatusPending')

const splitStatusFailedSchema = z
  .object({
    status: z.literal('failed'),
    reviewGroups: z.null(),
    message: z.string().nullable(),
  })
  .strict()
  .openapi('SplitStatusFailed')

const splitStatusEmptySchema = z
  .object({
    status: z.literal('empty'),
    reviewGroups: z.null(),
    message: z.string().nullable(),
  })
  .strict()
  .openapi('SplitStatusEmpty')

const splitStatusSingleGroupSchema = z
  .object({
    status: z.literal('single_group'),
    reviewGroups: z.null(),
    message: z.string().nullable(),
  })
  .strict()
  .openapi('SplitStatusSingleGroup')

export const splitStatusResponseSchema = z
  .discriminatedUnion('status', [
    splitStatusPendingSchema,
    splitStatusReadySchema,
    splitStatusFailedSchema,
    splitStatusEmptySchema,
    splitStatusSingleGroupSchema,
  ])
  .openapi('SplitStatusResponse')
