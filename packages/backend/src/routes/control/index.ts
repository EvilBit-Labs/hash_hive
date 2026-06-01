/**
 * Control API surface aggregator — `/api/v1/control/*`.
 *
 * Third API surface alongside dashboard (cookie session) and agent
 * (pre-shared bearer). Authentication is per-user API keys (see
 * `requireApiKey`), errors follow RFC 9457 problem-details
 * (`application/problem+json`), pagination uses `offset`/`limit`.
 *
 * Mirrors the dashboard surface aggregator: a single `OpenAPIHono`
 * instance whose registry merges the ten domain routers' route +
 * schema definitions into one spec. The cached `/openapi.json`
 * endpoint is mounted BEFORE the `requireApiKey` middleware so the
 * spec remains anonymously fetchable for client codegen and Swagger
 * UI tooling — gating it behind an API key would add friction without
 * a real security boundary (the spec is metadata that ships with the
 * running app anyway).
 *
 * The root `app` in `packages/backend/src/index.ts` stays plain `Hono`
 * so the three surfaces' specs stay strictly isolated: an
 * `OpenAPIHono` parent would auto-merge children's specs into a
 * top-level doc, breaking the per-surface `/openapi.json` contract.
 */

import { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { requireApiKey } from '../../middleware/api-key.js'
import { registerControlResponseComponents } from '../../openapi/components.js'
import { registerControlSecurity } from '../../openapi/security.js'
import { mountCachedSpec } from '../../openapi/spec-cache.js'
import { controlAgentRoutes } from './agents.js'
import { controlAttackRoutes } from './attacks.js'
import { controlCampaignRoutes } from './campaigns.js'
import { controlHashListRoutes } from './hashlists.js'
import { controlHealthRoutes } from './health.js'
import { controlProjectRoutes } from './projects.js'
import { controlResourceRoutes } from './resources.js'
import { controlStatsRoutes } from './stats.js'
import { controlTaskRoutes } from './tasks.js'
import { controlUserRoutes } from './users.js'

export const controlRoutes = new OpenAPIHono<AppEnv>()

// Components and security schemes register against THIS instance's
// registry; per-router registries are merged into it at mount time.
// Both registrars throw on duplicate registration, which makes this
// block boot-only and not re-entrant — if `registerControlSecurity`
// succeeds and `registerControlResponseComponents` then throws, the
// app is in a half-registered state and any subsequent call will
// throw on the security half too. That's the intended fail-fast
// posture (HMR reloads the module fresh in dev); production boots
// once.
registerControlSecurity(controlRoutes)
registerControlResponseComponents(controlRoutes)

// Spec endpoint goes on FIRST so the per-router auth middleware never
// gates it. Anonymous fetch is the contract for client codegen and
// Swagger UI consumers.
mountCachedSpec(controlRoutes, '/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'HashHive Control API',
    version: '2.0.0',
    description:
      'Machine-readable REST API for CLI tooling, automation platforms, and CI integrations. Authenticated by per-user API keys (`Authorization: Bearer cst_...`), paginated with `offset`/`limit`, and emits RFC 9457 problem-details (`application/problem+json`) on errors.',
  },
})

controlRoutes.use('*', requireApiKey)

controlRoutes.route('/health', controlHealthRoutes)
controlRoutes.route('/projects', controlProjectRoutes)
controlRoutes.route('/users', controlUserRoutes)
controlRoutes.route('/hashlists', controlHashListRoutes)
controlRoutes.route('/stats', controlStatsRoutes)
controlRoutes.route('/resources', controlResourceRoutes)
controlRoutes.route('/campaigns', controlCampaignRoutes)
controlRoutes.route('/attacks', controlAttackRoutes)
controlRoutes.route('/agents', controlAgentRoutes)
controlRoutes.route('/tasks', controlTaskRoutes)
