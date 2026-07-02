/**
 * Hash-list / resource archive & restore routes (ADR-0019, issue #106 U4).
 *
 * Extracted to its own file to mirror `campaigns-archive.ts`'s split from
 * `campaigns.ts`: the same bulk `{ ids }` POST /archive + POST /restore
 * shape, `requireMembershipRole('admin', 'contributor')` RBAC, and per-id
 * outcome response, backed by the `resources-archive.ts` service (U3).
 *
 * `registerHashListArchiveRoutes` mounts the hash-list pair on
 * `resourceRoutes` (`resources.ts`). `registerResourceArchiveRoutes` is a
 * factory the wordlist/rulelist/masklist registration in
 * `resources-generic.ts` calls once per resource table so URL paths stay
 * `/{prefix}/archive` and `/{prefix}/restore`.
 */

import {
  resourceArchiveRequestSchema,
  resourceArchiveResponseSchema,
  resourceRestoreResponseSchema,
} from '@hashhive/shared'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'

import type { ResourceTable } from '../../services/resources.js'
import type { AppEnv } from '../../types.js'

import { requireMembershipRole } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedDashboardResponse } from '../../openapi/components.js'
import {
  archiveHashLists,
  archiveResources,
  restoreHashLists,
  restoreResources,
} from '../../services/resources-archive.js'
import { security, tags } from './resources-shared.js'

const archiveResponses = {
  200: {
    description: 'Per-id archive outcomes.',
    content: { 'application/json': { schema: resourceArchiveResponseSchema } },
  },
  401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
} as const

const restoreResponses = {
  200: {
    description: 'Per-id restore outcomes.',
    content: { 'application/json': { schema: resourceRestoreResponseSchema } },
  },
  401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
} as const

export function registerHashListArchiveRoutes(router: OpenAPIHono<AppEnv>): void {
  const archiveRoute = createRoute({
    method: 'post',
    path: '/hash-lists/archive',
    tags,
    summary: 'Archive one or more permanent, unreferenced hash lists',
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      body: { content: { 'application/json': { schema: resourceArchiveRequestSchema } } },
    },
    responses: archiveResponses,
  })

  const restoreRoute = createRoute({
    method: 'post',
    path: '/hash-lists/restore',
    tags,
    summary: 'Restore one or more archived hash lists',
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      body: { content: { 'application/json': { schema: resourceArchiveRequestSchema } } },
    },
    responses: restoreResponses,
  })

  router.openapi(archiveRoute, async (c) => {
    const { projectId, userId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await archiveHashLists(projectId, ids, { actorType: 'user', actorId: userId })
    return c.json({ results }, 200)
  })

  router.openapi(restoreRoute, async (c) => {
    const { projectId, userId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await restoreHashLists(projectId, ids, { actorType: 'user', actorId: userId })
    return c.json({ results }, 200)
  })
}

export function registerResourceArchiveRoutes(
  router: OpenAPIHono<AppEnv>,
  prefix: string,
  table: ResourceTable
): void {
  const archiveRoute = createRoute({
    method: 'post',
    path: `/${prefix}/archive`,
    tags,
    summary: `Archive one or more permanent, unreferenced ${prefix} entries`,
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      body: { content: { 'application/json': { schema: resourceArchiveRequestSchema } } },
    },
    responses: archiveResponses,
  })

  const restoreRoute = createRoute({
    method: 'post',
    path: `/${prefix}/restore`,
    tags,
    summary: `Restore one or more archived ${prefix} entries`,
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      body: { content: { 'application/json': { schema: resourceArchiveRequestSchema } } },
    },
    responses: restoreResponses,
  })

  router.openapi(archiveRoute, async (c) => {
    const { projectId, userId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await archiveResources(table, projectId, ids, {
      actorType: 'user',
      actorId: userId,
    })
    return c.json({ results }, 200)
  })

  router.openapi(restoreRoute, async (c) => {
    const { projectId, userId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await restoreResources(table, projectId, ids, {
      actorType: 'user',
      actorId: userId,
    })
    return c.json({ results }, 200)
  })
}
