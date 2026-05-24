/**
 * Control API resource-file endpoints (wordlists, rules, masks).
 *
 * Read-only listing and inspection. Uploads stay on the dashboard
 * surface — presigned URLs and chunked-upload coordination are
 * interactive workflows that don't compose well with one-shot
 * automation. Mutating endpoints (POST/PATCH/DELETE) are not
 * implemented in this Control surface.
 */

import type { Context } from 'hono'

import { maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  getResourceById,
  listHashTypes,
  listResourcesPaginated,
  type ResourceTable,
} from '../../services/resources.js'
import { controlErrorResponse, parseIdParam, requireProjectMembership } from './helpers.js'

export const controlResourceRoutes = new Hono<AppEnv>()

const RESOURCE_KIND = z.enum(['wordlists', 'rulelists', 'masklists'])
type ResourceKind = z.infer<typeof RESOURCE_KIND>

const RESOURCE_TABLES: Record<ResourceKind, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
}

function resolveKind(c: Context<AppEnv>): ResourceKind | null {
  const parsed = RESOURCE_KIND.safeParse(c.req.param('kind'))
  return parsed.success ? parsed.data : null
}

/**
 * Hash-type catalog. Defined before the `/:kind` route so the literal
 * path matches first (Hono routes are evaluated in registration order
 * within a sub-application). Hash types are global lookup data, not
 * project-scoped resources — automation clients need this endpoint to
 * resolve a hash-type name into the numeric ID accepted by the
 * createAttack endpoint without having to authenticate via the
 * dashboard cookie session.
 */
controlResourceRoutes.get('/hash-types', async (c) => {
  try {
    // Membership check ensures the caller has a valid API key and at
    // least one project — the response itself is not project-scoped.
    await requireProjectMembership(c)
    const types = await listHashTypes()
    return c.json({ hashTypes: types })
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

controlResourceRoutes.get('/:kind', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const kind = resolveKind(c)
    if (!kind) {
      return problemResponse(
        c,
        400,
        'validation',
        'kind must be one of: wordlists, rulelists, masklists'
      )
    }
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams))
    const { items, total } = await listResourcesPaginated(RESOURCE_TABLES[kind], projectId, {
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(items, total, query))
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

controlResourceRoutes.get('/:kind/:id', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const kind = resolveKind(c)
    if (!kind) {
      return problemResponse(
        c,
        400,
        'validation',
        'kind must be one of: wordlists, rulelists, masklists'
      )
    }
    const id = parseIdParam(c.req.param('id'))
    const resource = await getResourceById(RESOURCE_TABLES[kind], id, projectId)
    if (!resource) return problemResponse(c, 404, 'not_found', 'resource not found')
    return c.json(resource)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
