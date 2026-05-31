/**
 * Per-surface OpenAPI security scheme registration.
 *
 * Each of the three HashHive API surfaces uses a distinct authentication
 * mechanism. `OpenAPIHono`'s `openAPIRegistry` is per-instance, so each
 * surface declares its own scheme on its own registry — there is no
 * shared registry to mutate. Routes reference these schemes via
 * `security: [{ <SchemeName>: [] }]` in their `createRoute(...)`
 * definitions.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from 'hono'

/**
 * BetterAuth cookie session — used by the dashboard surface.
 *
 * The cookie name matches the BetterAuth-emitted session cookie. Path
 * stays under `/api/v1/dashboard/*` and the cookie is `SameSite=Strict`
 * by configuration (see `packages/backend/src/lib/auth.ts`). The spec
 * declares the scheme as `apiKey in cookie` because BetterAuth does not
 * implement HTTP `Set-Cookie` with an OAuth bearer shape; the OpenAPI
 * vocabulary's nearest fit is `apiKey in cookie`.
 */
export function registerDashboardSecurity<E extends Env>(app: OpenAPIHono<E>): void {
  // Scheme name `SessionCookie` and cookie name `hh.session_token`
  // mirror packages/openapi/dashboard-api.yaml so the runtime spec
  // matches the hand-rolled YAML at the MVP diff gate (R5). The cookie
  // is set by `/api/auth/sign-in/*` via BetterAuth (see
  // packages/backend/src/lib/auth.ts); SameSite=Strict and per-route
  // Origin/Referer checks via requireSameOrigin() form defense in depth.
  app.openAPIRegistry.registerComponent('securitySchemes', 'SessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'hh.session_token',
    description:
      'BetterAuth cookie session set by `/api/auth/sign-in/*`. SameSite=Strict; the request must also pass the per-domain Origin/Referer check enforced by requireSameOrigin().',
  })
}

/**
 * Control API key — used by the control surface.
 *
 * Tokens are issued from the dashboard Account page (`cst_*` format,
 * bcrypt-hashed in `users.api_key_hash`). Sent via the
 * `Authorization: Bearer cst_...` header.
 */
export function registerControlSecurity<E extends Env>(app: OpenAPIHono<E>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'ControlApiKey', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'cst_<userId>_<random>',
    description:
      'Per-user Control API key. Issue and rotate from the dashboard Account page (`/account`). Sent as `Authorization: Bearer cst_...`.',
  })
}

/**
 * Agent pre-shared bearer token — used by the agent surface.
 *
 * Each registered hashcat agent has its own token (bcrypt-hashed in
 * `agents.auth_token_hash`, with legacy plaintext support via
 * `agents.auth_token` during the rotation window). Sent via the
 * `Authorization: Bearer <token>` header.
 */
export function registerAgentSecurity<E extends Env>(app: OpenAPIHono<E>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'AgentBearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'agt_<agentId>_<random> (bcrypt-format) or legacy UUID',
    description:
      'Pre-shared agent token issued at agent registration. Bcrypt-format tokens carry an `agt_` prefix and a numeric agentId hint; legacy plaintext tokens are raw UUIDs (rotation window — see GOTCHAS).',
  })
}
