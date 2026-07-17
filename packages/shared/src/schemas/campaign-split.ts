/**
 * Campaign-wizard split + review flow wire shapes (issue #202, unit SU3).
 *
 * `POST /api/v1/dashboard/campaigns` returns `SplitReviewGroups` (200)
 * instead of a created campaign (201) when the target hash list's
 * `type_analysis.verdict` is `mixed`/`needs-review` and the split classifier
 * found more than one group. The caller then resolves the `ambiguous`
 * groups' candidate modes and posts `ConfirmSplitCampaignRequest` to
 * `POST /api/v1/dashboard/campaigns/split/confirm`, which creates the
 * parent campaign plus one single-mode sub-campaign per resolved sub-list
 * (`ConfirmSplitCampaignResponse`).
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
    candidateModes: z.array(z.number().int().nonnegative()),
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
