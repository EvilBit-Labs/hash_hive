/**
 * Dashboard surface aggregator.
 *
 * Composes the twelve dashboard domain routers into one `OpenAPIHono`
 * instance and serves the per-surface OpenAPI spec at `/openapi.json`
 * (resolved to `/api/v1/dashboard/openapi.json` after mounting in
 * `packages/backend/src/index.ts`).
 *
 * Why an aggregator: each domain router (`auth`, `projects`, `agents`,
 * …) is its own `OpenAPIHono` so routes register against the domain's
 * registry. The aggregator parent merges all twelve registries into a
 * single dashboard spec, matching the plan's D1 decision. The root
 * `app` in `packages/backend/src/index.ts` stays plain `Hono` so the
 * agent and control surfaces' independent specs are not pulled into
 * the dashboard's.
 *
 * The spec endpoint is registered BEFORE any auth middleware so it
 * remains anonymously fetchable (plan D2 — `/openapi.json` is metadata
 * that ships with the running app).
 */

import type { createBunWebSocket } from 'hono/bun'

import { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { registerDashboardResponseComponents } from '../../openapi/components.js'
import { registerDashboardSecurity } from '../../openapi/security.js'
import { mountCachedSpec } from '../../openapi/spec-cache.js'
import { dashboardAgentRoutes } from './agents.js'
import { attackTemplateRoutes } from './attack-templates.js'
import { authRoutes } from './auth.js'
import { campaignRoutes } from './campaigns.js'
import { crackerRoutes } from './crackers.js'
import { createEventRoutes } from './events.js'
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
  // never gates it. `mountCachedSpec` adds a `GET /openapi.json` route
  // to this aggregator directly.
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
  surface.route('/resources', resourceRoutes)
  surface.route('/hashes', hashRoutes)
  surface.route('/attack-templates', attackTemplateRoutes)
  surface.route('/campaigns', campaignRoutes)
  surface.route('/tasks', taskRoutes)
  surface.route('/stats', statsRoutes)
  surface.route('/results', resultsRoutes)
  surface.route('/events', eventRoutes)
  surface.route('/crackers', crackerRoutes)
  surface.route('/health', healthRoutes)

  return surface
}
