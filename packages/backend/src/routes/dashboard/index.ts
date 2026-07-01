/**
 * Dashboard surface aggregator.
 *
 * Composes the twelve dashboard domain routers into one `OpenAPIHono`
 * instance and serves the per-surface OpenAPI spec at `/openapi.json`
 * (resolved to `/api/v1/dashboard/openapi.json` after mounting in
 * `packages/backend/src/index.ts`).
 *
 * Each domain router (`auth`, `projects`, `agents`, etc.) is its own
 * `OpenAPIHono`. The aggregator parent merges all twelve registries
 * into a single dashboard spec. The root `app` in
 * `packages/backend/src/index.ts` stays plain `Hono` so the agent and
 * control surfaces' independent specs are not pulled into the
 * dashboard's spec — this is the invariant that keeps the three API
 * surfaces' specs strictly isolated.
 *
 * The spec endpoint is registered BEFORE any auth middleware so it
 * remains anonymously fetchable. The spec is metadata that ships with
 * the running app; gating it behind a session would break client
 * codegen tooling and Swagger UI integrations without providing a
 * real security boundary.
 *
 * **Transitional state.** The `SessionCookie` security scheme is
 * registered against this surface's registry, but no domain route
 * currently references it via `security: [{ SessionCookie: [] }]` in
 * a `createRoute(...)` definition — the routes still go through the
 * existing `router.use('*', requireSession)` middleware and use
 * `.get/.post` rather than `.openapi(createRoute(...), handler)`.
 * The route-by-route conversion lands in a follow-on PR. Until then,
 * the served spec correctly shows the scheme as defined-but-unused.
 */

import type { createBunWebSocket } from 'hono/bun'

import { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { registerDashboardResponseComponents } from '../../openapi/components.js'
import { registerDashboardSecurity } from '../../openapi/security.js'
import { mountCachedSpec } from '../../openapi/spec-cache.js'
import { dashboardAgentConfigRoutes } from './agent-config.js'
import { dashboardAgentRoutes } from './agents.js'
import { attackTemplateRoutes } from './attack-templates.js'
import { auditLogRoutes } from './audit-logs.js'
import { authRoutes } from './auth.js'
import { campaignRoutes } from './campaigns.js'
import { crackerRoutes } from './crackers.js'
import { enrollmentTokenRoutes } from './enrollment-tokens.js'
import { createEventRoutes } from './events.js'
import { hashListsRoutes } from './hash-lists.js'
import { hashRoutes } from './hashes.js'
import { healthRoutes } from './health.js'
import { projectRoutes } from './projects.js'
import { resourceRoutes } from './resources.js'
import { resultsRoutes } from './results.js'
import { statsRoutes } from './stats.js'
import { taskRoutes } from './tasks.js'

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket']

/**
 * Build the dashboard surface. Takes the same `upgradeWebSocket`
 * factory that `packages/backend/src/index.ts` already constructs;
 * keeps the websocket plumbing co-located with the rest of the surface.
 */
export function createDashboardSurface(upgradeWebSocket: UpgradeWebSocket): OpenAPIHono<AppEnv> {
  const surface = new OpenAPIHono<AppEnv>()

  // Components and security schemes register against THIS instance's
  // registry; per-router registries are merged into it at mount time.
  registerDashboardSecurity(surface)
  registerDashboardResponseComponents(surface)

  // Spec endpoint goes on FIRST so the per-router auth middleware
  // (which each domain router applies via `router.use('*', requireSession)`)
  // never gates it. The cached spec serves anonymously; client codegen
  // and Swagger UI consumers expect that.
  mountCachedSpec(surface, '/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'HashHive Dashboard API',
      version: '1.0.0',
      description:
        'Cookie-authenticated dashboard surface used by the React frontend. Project scope is server-managed via the BetterAuth session.',
    },
  })

  const eventRoutes = createEventRoutes(upgradeWebSocket)

  surface.route('/auth', authRoutes)
  surface.route('/projects', projectRoutes)
  surface.route('/agents', dashboardAgentRoutes)
  surface.route('/', dashboardAgentConfigRoutes)
  surface.route('/enrollment-tokens', enrollmentTokenRoutes)
  surface.route('/resources', resourceRoutes)
  surface.route('/hashes', hashRoutes)
  surface.route('/attack-templates', attackTemplateRoutes)
  surface.route('/campaigns', campaignRoutes)
  surface.route('/tasks', taskRoutes)
  surface.route('/stats', statsRoutes)
  surface.route('/results', resultsRoutes)
  surface.route('/audit-logs', auditLogRoutes)
  surface.route('/hash-lists', hashListsRoutes)
  surface.route('/events', eventRoutes)
  surface.route('/crackers', crackerRoutes)
  surface.route('/health', healthRoutes)

  return surface
}
