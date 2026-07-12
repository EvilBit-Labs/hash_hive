import { authMethodsSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
import {
  getUserApiKeyMetadata,
  getUserWithProjects,
  issueUserApiKey,
  revokeUserApiKey,
} from '../../services/auth.js'

const authRouter = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// This router also serves the anonymous /methods discovery endpoint (U8,
// KTD8) below, so a blanket `use('*', requireSession)` would incorrectly
// gate it. Apply requireSession per-path instead, mirroring the same
// pattern in `routes/dashboard/agent-config.ts`.
authRouter.use('/me', requireSession)
authRouter.use('/me/api-key', requireSession)

// The /me/api-key responses set `Cache-Control: no-store` and `Pragma:
// no-cache` at runtime (see the per-handler `c.header(...)` calls
// below). Spec-level declaration of those headers via createRoute's
// `responses[status].headers` would require the library's
// `HeadersObject` shape (Zod-shape per header, not the loose
// `{ schema, description }` literal that intuitively fits); the
// awkward shape isn't worth the spec-side documentation gain when the
// route description already names the invariant. Tightening the
// header declaration is a follow-up; the per-route description prose
// is the operator-visible contract today.

// ─── Shared response shapes ─────────────────────────────────────────
//
// These schemas mirror `getUserWithProjects` / `issueUserApiKey` /
// `getUserApiKeyMetadata` in `services/auth.ts`. Keep them aligned: any
// drift between the handler's return shape and the schemas declared
// here surfaces as a wrong OpenAPI spec, which the generated TypeScript
// client (and downstream consumers) trust as the contract.
//
// `apiKeyMetadataSchema` is a discriminated union on `hasKey` so an
// inconsistent value (`{ hasKey: true }` with `prefix: null`) cannot be
// constructed at compile time — matches the `ApiKeyMetadata` type in
// `@hashhive/shared`.

const meUserSchema = z.object({
  id: z.number().int().positive(),
  email: z.string(),
  name: z.string(),
  status: z.string(),
  roles: z.array(z.string()).min(1),
})

const meProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  slug: z.string(),
  roles: z.array(z.string()).min(1),
})

const meResponseSchema = z
  .object({
    user: meUserSchema,
    projects: z.array(meProjectSchema),
    selectedProjectId: z.number().int().positive().nullable(),
  })
  .openapi('MeResponse')

const apiKeyMetadataAbsentSchema = z.object({ hasKey: z.literal(false) })
const apiKeyMetadataPresentSchema = z.object({
  hasKey: z.literal(true),
  prefix: z.string(),
  lastUsedAt: z.string().nullable(),
})

const apiKeyMetadataSchema = z
  .union([apiKeyMetadataAbsentSchema, apiKeyMetadataPresentSchema])
  .openapi('ApiKeyMetadata')

const issueApiKeyResponseSchema = z
  .object({
    token: z.string(),
    // Issuance always returns the present variant — the service
    // unconditionally writes `hasKey: true` with the new prefix.
    metadata: apiKeyMetadataPresentSchema,
  })
  .openapi('IssueApiKeyResponse')

// ─── GET /methods — anonymous auth-method discovery (U8, KTD8) ──────
//
// No `security` entry and NOT covered by the per-path `requireSession`
// wiring above -- this must stay anonymously fetchable, mirroring how
// the dashboard `/openapi.json` spec endpoint is exposed. The login
// page polls this to decide whether to render the directory sign-in
// option (R20). Never leaks any LDAP configuration beyond the on/off
// flag: no URL, bind DN, search base, or group map.

const getAuthMethodsRoute = createRoute({
  method: 'get',
  path: '/methods',
  tags: ['Auth'],
  summary: 'Discover which sign-in methods are enabled (anonymous)',
  description:
    'Anonymous endpoint the login page polls to decide whether to render the directory (AD/LDAP) sign-in option (R20). `local` is always true; `ldap` mirrors `env.LDAP_ENABLED`. Carries no other directory configuration (KTD8).',
  responses: {
    200: {
      description: 'Enabled authentication methods.',
      content: { 'application/json': { schema: authMethodsSchema } },
    },
  },
})

authRouter.openapi(getAuthMethodsRoute, (c) => {
  return c.json({ local: true, ldap: env.LDAP_ENABLED }, 200)
})

// ─── GET /me — authenticated user profile + projects ────────────────

const getMeRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Auth'],
  summary: "Return the authenticated user's profile and project memberships",
  description:
    'Frontend (#160 selector UI) consumes `selectedProjectId` to decide whether to land on the dashboard or the selector in a single round trip, rather than waiting for the WebSocket subscription to hydrate `useUiStore.selectedProjectId`. `selectedProjectId` mirrors `currentUser.projectId`, sourced exclusively from the server-managed BetterAuth session row (issue #159 U4).',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'User profile, memberships, and selected project context.',
      content: { 'application/json': { schema: meResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

authRouter.openapi(getMeRoute, async (c) => {
  const { userId, projectId } = c.get('currentUser')
  // Wrapped in try/catch for symmetry with sibling /me/api-key routes.
  // A DB blip during getUserWithProjects would otherwise bubble as an
  // unstructured 500 and bypass the dashboard error envelope.
  try {
    const result = await getUserWithProjects(userId)
    if (!result) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'User not found')
    }
    // Coerce undefined → null so the field is always present per
    // meResponseSchema's nullable() contract.
    return c.json({ ...result, selectedProjectId: projectId ?? null }, 200)
  } catch (err) {
    logger.error({ err, userId, op: 'getUserWithProjects' }, 'GET /me lookup failed')
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Failed to read user profile')
  }
})

// ─── /me/api-key — issue / read / revoke ────────────────────────────
// Each handler wraps in try/catch so a transient DB failure surfaces
// as a structured 500 with operation + userId in the log, rather than
// bubbling to Hono's default handler which would leave a partial-write
// incident invisible.

const issueApiKeyRoute = createRoute({
  method: 'post',
  path: '/me/api-key',
  tags: ['Auth'],
  summary: 'Issue a new Control API key for the authenticated user',
  description:
    'The raw token is returned exactly once. Subsequent reads via GET /me/api-key surface only metadata. Response is marked uncacheable (Cache-Control + Pragma) for legacy intermediaries.',
  security: [{ SessionCookie: [] }],
  responses: {
    201: {
      description: 'API key issued; token returned once.',
      content: { 'application/json': { schema: issueApiKeyResponseSchema } },
    },
    200: {
      description: 'API key issued; token returned once (legacy response code).',
      content: { 'application/json': { schema: issueApiKeyResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

authRouter.openapi(issueApiKeyRoute, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    const { token, metadata } = await issueUserApiKey(userId)
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({ token, metadata }, 200)
  } catch (err) {
    logger.error({ err, userId, op: 'issueUserApiKey' }, 'API key issue failed')
    return dashboardError(c, 500, 'API_KEY_ISSUE_FAILED', 'Failed to issue API key')
  }
})

const getApiKeyRoute = createRoute({
  method: 'get',
  path: '/me/api-key',
  tags: ['Auth'],
  summary: "Read the authenticated user's API key metadata (no raw token)",
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description:
        'API key metadata. `{ hasKey: false }` when the user has no active key; `{ hasKey: true, prefix, lastUsedAt }` otherwise.',
      content: { 'application/json': { schema: apiKeyMetadataSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

authRouter.openapi(getApiKeyRoute, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    const metadata = await getUserApiKeyMetadata(userId)
    c.header('Cache-Control', 'no-store')
    return c.json(metadata, 200)
  } catch (err) {
    logger.error({ err, userId, op: 'getUserApiKeyMetadata' }, 'API key metadata read failed')
    return dashboardError(c, 500, 'API_KEY_READ_FAILED', 'Failed to read API key metadata')
  }
})

const revokeApiKeyRoute = createRoute({
  method: 'delete',
  path: '/me/api-key',
  tags: ['Auth'],
  summary: "Revoke the authenticated user's Control API key",
  security: [{ SessionCookie: [] }],
  responses: {
    204: { description: 'API key revoked.' },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

authRouter.openapi(revokeApiKeyRoute, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    await revokeUserApiKey(userId)
    return c.body(null, 204)
  } catch (err) {
    logger.error({ err, userId, op: 'revokeUserApiKey' }, 'API key revoke failed')
    return dashboardError(c, 500, 'API_KEY_REVOKE_FAILED', 'Failed to revoke API key')
  }
})

export { authRouter as authRoutes }
