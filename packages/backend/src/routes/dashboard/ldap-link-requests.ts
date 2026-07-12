/**
 * Dashboard AD/LDAP admin reconciliation routes (U7, R12).
 *
 * `GET /api/v1/dashboard/ldap-link-requests` -- list the open
 * (`pending`) directory-login collisions written by U4's
 * `resolveDirectoryUser` (R11).
 *
 * `POST /api/v1/dashboard/ldap-link-requests/{id}/resolve` -- an admin
 * links the pending directory identity to a chosen local account or
 * rejects it. See `services/ldap-reconciliation.ts` for the full
 * resolution semantics (deliberately does not touch `users.roles`).
 *
 * Global-admin only (`requireRole('admin')`) -- reconciliation grants a
 * directory identity access to a local account, so it carries the same
 * privilege as creating a project or a cracker binary (mirrors
 * `routes/dashboard/crackers.ts` / `projects.ts`).
 *
 * Patterns followed:
 *   - `routes/dashboard/audit-logs.ts`   -- paginated list + createRoute shape
 *   - `routes/dashboard/crackers.ts`     -- global (non-project-scoped) admin-only router
 */
import {
  ldapLinkRequestListResponseSchema,
  resolveLdapLinkRequestBodySchema,
  resolveLdapLinkRequestResponseSchema,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireRole } from '../../middleware/rbac.js'
import { coercedIntegerQuery } from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import {
  LdapLinkRequestAlreadyResolvedError,
  LdapLinkRequestNotFoundError,
  LdapLinkTargetAlreadyLinkedError,
  LdapLinkTargetNotFoundError,
  listPendingLinkRequests,
  resolveLinkRequest,
} from '../../services/ldap-reconciliation.js'

export const ldapLinkRequestRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

ldapLinkRequestRoutes.use('*', requireSession)

// ─── Pagination constants ────────────────────────────────────────────────

const LDAP_LINK_REQUEST_LIST_MAX_LIMIT = 200
const LDAP_LINK_REQUEST_LIST_DEFAULT_LIMIT = 50

const adminAuthResponses = {
  401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
} as const

// ─── List ────────────────────────────────────────────────────────────────

const listLinkRequestsQuerySchema = z.object({
  limit: coercedIntegerQuery({
    min: 1,
    max: LDAP_LINK_REQUEST_LIST_MAX_LIMIT,
    default: LDAP_LINK_REQUEST_LIST_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

const listLinkRequestsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['LDAP Reconciliation'],
  summary: 'List pending AD/LDAP directory-login collisions (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { query: listLinkRequestsQuerySchema },
  responses: {
    200: {
      description: 'Page of open (pending) reconciliation requests.',
      content: { 'application/json': { schema: ldapLinkRequestListResponseSchema } },
    },
    ...adminAuthResponses,
  },
})

ldapLinkRequestRoutes.openapi(listLinkRequestsRoute, async (c) => {
  const { limit, offset } = c.req.valid('query')
  try {
    const result = await listPendingLinkRequests({ limit, offset })
    return c.json(result, 200)
  } catch (err) {
    logger.error({ err }, 'ldap-link-requests: listPendingLinkRequests failed')
    return dashboardError(
      c,
      500,
      'LDAP_LINK_REQUEST_LIST_FAILED',
      'Failed to list pending directory link requests'
    )
  }
})

// ─── Resolve ─────────────────────────────────────────────────────────────

const linkRequestIdParamSchema = z.object({ id: z.coerce.number().int().positive() })

const resolveLinkRequestRoute = createRoute({
  method: 'post',
  path: '/{id}/resolve',
  tags: ['LDAP Reconciliation'],
  summary: 'Link or reject a pending AD/LDAP directory-login collision (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    params: linkRequestIdParamSchema,
    body: { content: { 'application/json': { schema: resolveLdapLinkRequestBodySchema } } },
  },
  responses: {
    200: {
      description: 'The resolved (linked or rejected) request.',
      content: { 'application/json': { schema: resolveLdapLinkRequestResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description:
        'The request was already resolved, or the link would violate identity uniqueness.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

ldapLinkRequestRoutes.openapi(resolveLinkRequestRoute, async (c) => {
  const { id } = c.req.valid('param')
  const body = c.req.valid('json')
  // currentUser is guaranteed by requireSession (route-level middleware)
  // running before this handler.
  const admin = c.get('currentUser')
  if (!admin) {
    return dashboardError(c, 401, 'AUTH_TOKEN_INVALID', 'Authentication required')
  }

  try {
    // resolveLdapLinkRequestBodySchema is a discriminated union on `action`,
    // so narrowing here gives a non-optional `targetUserId` with no cast.
    const input =
      body.action === 'link'
        ? ({ requestId: id, action: 'link', targetUserId: body.targetUserId } as const)
        : ({ requestId: id, action: 'reject' } as const)
    const linkRequest = await resolveLinkRequest(input, {
      actorType: 'user',
      actorId: admin.userId,
    })
    return c.json({ linkRequest }, 200)
  } catch (err) {
    if (err instanceof LdapLinkRequestNotFoundError) {
      return dashboardError(c, 404, 'LDAP_LINK_REQUEST_NOT_FOUND', err.message)
    }
    if (err instanceof LdapLinkRequestAlreadyResolvedError) {
      return dashboardError(c, 409, 'LDAP_LINK_REQUEST_ALREADY_RESOLVED', err.message)
    }
    if (err instanceof LdapLinkTargetNotFoundError) {
      return dashboardError(c, 404, 'LDAP_LINK_TARGET_NOT_FOUND', err.message)
    }
    if (err instanceof LdapLinkTargetAlreadyLinkedError) {
      return dashboardError(c, 409, 'LDAP_LINK_TARGET_ALREADY_LINKED', err.message)
    }
    logger.error({ err, requestId: id }, 'ldap-link-requests: resolveLinkRequest failed')
    return dashboardError(c, 500, 'LDAP_LINK_RESOLVE_FAILED', 'Failed to resolve link request')
  }
})
