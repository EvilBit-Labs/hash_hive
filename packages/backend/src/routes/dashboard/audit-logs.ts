/**
 * Dashboard audit-log routes — `GET /api/v1/dashboard/audit-logs`.
 *
 * Project-scoped, paginated, filterable audit history. Access is restricted
 * to admin and contributor membership roles (R11 — viewers receive 403).
 *
 * Patterns followed:
 *   - `routes/dashboard/results.ts`  — inline pagination + filter params + createRoute shape
 *   - `routes/dashboard/enrollment-tokens.ts` — requireMembershipRole gate
 *   - dashboard read-endpoint three-pillar convention (shared schema bound in route)
 */
import { auditLogListResponseSchema, auditLogQuerySchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole } from '../../middleware/rbac.js'
import {
  coercedIntegerQuery,
  coercedOptionalPositiveIntegerQuery,
} from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import { listAuditEvents } from '../../services/audit-log.js'
import { getScopedProjectId } from './scoped-user.js'

export const auditLogRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// All audit-log routes require a session; the list route additionally requires
// admin or contributor membership (R11). The middleware is declared inline on
// the createRoute so the OpenAPI middleware array carries it.
auditLogRoutes.use('*', requireSession)

// ─── Pagination + filter constants ──────────────────────────────────────────

const AUDIT_LIST_MAX_LIMIT = 200
const AUDIT_LIST_DEFAULT_LIMIT = 50

// ─── Query schema ────────────────────────────────────────────────────────────

/**
 * Filter helper for optional enum query params. Resolves to undefined on
 * missing or malformed input (no filter applied) rather than 400.
 *
 * The `.openapi({ type: 'string' })` annotation is required for spec-gen:
 * `@hono/zod-openapi`'s generator throws `UnknownZodTypeError` on any schema
 * that uses `.catch(...)` without an explicit hint, mirroring the same
 * constraint documented in `openapi/coerced-query.ts`.
 */
function enumFilterQuery<T extends [string, ...string[]]>(values: T) {
  return z.enum(values).optional().catch(undefined).openapi({ type: 'string', enum: values })
}

/**
 * ISO datetime filter — falls back to undefined (no filter) on bad input,
 * matching the dashboard surface's permissive filter posture.
 */
function isoDateTimeFilterQuery() {
  return z
    .string()
    .datetime()
    .optional()
    .catch(undefined)
    .openapi({ type: 'string', format: 'date-time' })
}

const listAuditLogsQuerySchema = z.object({
  entityType: enumFilterQuery(
    auditLogQuerySchema.shape.entityType.unwrap().options as [string, ...string[]]
  ),
  entityId: coercedOptionalPositiveIntegerQuery(),
  actorType: enumFilterQuery(
    auditLogQuerySchema.shape.actorType.unwrap().options as [string, ...string[]]
  ),
  action: enumFilterQuery(
    auditLogQuerySchema.shape.action.unwrap().options as [string, ...string[]]
  ),
  dateFrom: isoDateTimeFilterQuery(),
  dateTo: isoDateTimeFilterQuery(),
  limit: coercedIntegerQuery({
    min: 1,
    max: AUDIT_LIST_MAX_LIMIT,
    default: AUDIT_LIST_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

// ─── Route definition ────────────────────────────────────────────────────────

const listAuditLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Audit Logs'],
  summary: 'Project-scoped paginated audit log with actor/entity label resolution',
  security: [{ SessionCookie: [] }],
  // R11: admin and contributor may read; viewer receives 403.
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: { query: listAuditLogsQuerySchema },
  responses: {
    200: {
      description: 'Page of audit log entries with resolved actor and entity labels.',
      content: { 'application/json': { schema: auditLogListResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

auditLogRoutes.openapi(listAuditLogsRoute, async (c) => {
  const scope = getScopedProjectId(c, 'audit-logs')
  if (!scope.ok) {
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
  const { projectId } = scope

  const { limit, offset, entityType, entityId, actorType, action, dateFrom, dateTo } =
    c.req.valid('query')

  try {
    const result = await listAuditEvents(
      projectId,
      { entityType, entityId, actorType, action, dateFrom, dateTo },
      { limit, offset }
    )
    return c.json(result, 200)
  } catch (err) {
    logger.error({ err, projectId }, 'audit-logs: listAuditEvents failed')
    return dashboardError(c, 500, 'AUDIT_LOG_LIST_FAILED', 'Failed to retrieve audit logs')
  }
})

export { auditLogRoutes as auditLogsRoutes }
