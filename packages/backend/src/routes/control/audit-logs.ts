/**
 * Control API audit-log endpoints — `GET /api/v1/control/audit-logs`.
 *
 * Project-scoped, paginated, filterable audit history. Access is restricted
 * to admin and contributor roles (R11 — viewer-role callers receive 403).
 *
 * Wire shape follows the control surface conventions:
 *   - Auth: per-user API key via `requireApiKey` (parent middleware)
 *   - Project scoping: `requireProjectRole` with 'admin' | 'contributor'
 *   - Pagination: `paginationQuerySchema` (offset/limit) + `paginate` helper
 *   - Errors: RFC 9457 `application/problem+json` via `controlErrorResponse`
 *   - Response: Paginated<AuditLog> with `items` key (not `data`)
 *
 * Patterns followed:
 *   - `routes/control/campaigns.ts` — createRoute shape, RBAC gating, paginate
 *   - `routes/dashboard/audit-logs.ts` — filter-param parsing, listAuditEvents call
 */
import {
  AUDIT_ACTION_VALUES,
  AUDIT_ACTOR_TYPE_VALUES,
  AUDIT_ENTITY_TYPE_VALUES,
  auditLogSchema,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { enumFilterQuery, isoDateTimeFilterQuery } from '../../openapi/coerced-query.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { listAuditEvents } from '../../services/audit-log.js'
import { controlErrorResponse, requireProjectRole } from './helpers.js'

export const controlAuditLogRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

// ─── Response schema ─────────────────────────────────────────────────────────

/**
 * Control-surface paginated audit-log page. Uses `items` (not `data`) to
 * match the control surface `Paginated<T>` convention used by campaigns,
 * agents, and other control list endpoints.
 */
const controlAuditLogPageSchema = z
  .object({
    items: z.array(auditLogSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlAuditLogPage')

// ─── Filter query schema ──────────────────────────────────────────────────────

/**
 * Control audit-log query schema: pagination (paginationQuerySchema) merged
 * with audit-specific filters. Mirrors the dashboard filter set exactly so
 * both surfaces accept the same filter vocabulary.
 */
const controlAuditLogQuerySchema = paginationQuerySchema.merge(
  z.object({
    entityType: enumFilterQuery(AUDIT_ENTITY_TYPE_VALUES),
    entityId: z.coerce.number().int().positive().optional().openapi({ type: 'integer' }),
    actorType: enumFilterQuery(AUDIT_ACTOR_TYPE_VALUES),
    action: enumFilterQuery(AUDIT_ACTION_VALUES),
    dateFrom: isoDateTimeFilterQuery(),
    dateTo: isoDateTimeFilterQuery(),
  })
)

// ─── GET / — list audit events ────────────────────────────────────────────────

const listAuditLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Audit Logs'],
  summary: 'List project audit events (admin/contributor only)',
  description:
    'Returns a paginated, newest-first audit trail for the active project. ' +
    'Restricted to admin and contributor roles (R11). ' +
    'Resolved actor and entity labels are included in every row.',
  security: [{ ControlApiKey: [] }],
  request: { query: controlAuditLogQuerySchema },
  responses: {
    200: {
      description: 'Page of audit log entries with resolved actor and entity labels.',
      content: { 'application/json': { schema: controlAuditLogPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAuditLogRoutes.openapi(listAuditLogsRoute, async (c) => {
  try {
    // R11: restrict to admin and contributor; viewer receives 403 via requireProjectRole
    const { projectId } = await requireProjectRole(c, 'admin', 'contributor')

    const query = c.req.valid('query')
    const { limit, offset, entityType, entityId, actorType, action, dateFrom, dateTo } = query

    const result = await listAuditEvents(
      projectId,
      { entityType, entityId, actorType, action, dateFrom, dateTo },
      { limit, offset }
    )

    // Control surface uses `items` key; map from service's `data` key
    return c.json(paginate(result.data, result.total, { limit, offset }), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
