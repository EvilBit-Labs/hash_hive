/**
 * Per-surface OpenAPI security scheme registration.
 *
 * Each of the three HashHive API surfaces uses a distinct authentication
 * mechanism. `OpenAPIHono`'s `openAPIRegistry` is per-instance, so each
 * surface declares its own scheme on its own registry; there is no
 * shared registry to mutate. Routes reference these schemes via
 * `security: [{ <SchemeName>: [] }]` in their `createRoute(...)`
 * definitions.
 *
 * Each registrar throws on duplicate registration so a future caller
 * that mounts two surfaces onto a shared registry fails loudly instead
 * of silently last-writer-wins.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from 'hono'

/**
 * Dashboard cookie session.
 *
 * Cookie name `hh.session_token` must match the runtime cookie issued
 * by BetterAuth (configured in `packages/backend/src/lib/auth.ts`);
 * `auth.ts` is the source of truth. Path stays under
 * `/api/v1/dashboard/*`. The cookie is `SameSite=Strict` by config and
 * per-route Origin/Referer checks via `requireSameOrigin()` form
 * defense in depth. The OpenAPI vocabulary's nearest fit for a server-
 * issued cookie session is `apiKey in cookie`.
 */
export function registerDashboardSecurity<E extends Env>(app: OpenAPIHono<E>): void {
  guardDuplicateSchemeRegistration(app, 'SessionCookie')
  app.openAPIRegistry.registerComponent('securitySchemes', 'SessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'hh.session_token',
    description:
      'BetterAuth cookie session set by `/api/auth/sign-in/*`. SameSite=Strict; the request must also pass the per-domain Origin/Referer check enforced by requireSameOrigin().',
  })
}

/**
 * Control API key.
 *
 * Tokens are issued from the dashboard Account page (`cst_*` format,
 * bcrypt-hashed in `users.api_key_hash`). Sent via
 * `Authorization: Bearer cst_...`.
 */
export function registerControlSecurity<E extends Env>(app: OpenAPIHono<E>): void {
  guardDuplicateSchemeRegistration(app, 'ControlApiKey')
  app.openAPIRegistry.registerComponent('securitySchemes', 'ControlApiKey', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'cst_<userId>_<random>',
    description:
      'Per-user Control API key. Issue and rotate from the dashboard Account page (`/account`). Sent as `Authorization: Bearer cst_...`.',
  })
}

/**
 * Agent pre-shared bearer token.
 *
 * Each registered hashcat agent has its own token (bcrypt-hashed in
 * `agents.auth_token_hash`, with legacy plaintext support via
 * `agents.auth_token` during the rotation window). Sent via
 * `Authorization: Bearer <token>`.
 */
export function registerAgentSecurity<E extends Env>(app: OpenAPIHono<E>): void {
  guardDuplicateSchemeRegistration(app, 'AgentBearer')
  app.openAPIRegistry.registerComponent('securitySchemes', 'AgentBearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'agt_<agentId>_<random> (bcrypt-format) or legacy UUID',
    description:
      'Pre-shared agent token issued at agent registration. Bcrypt-format tokens carry an `agt_` prefix and a numeric agentId hint; legacy plaintext tokens are raw UUIDs (rotation window — see GOTCHAS).',
  })
}

/**
 * Throws when a security scheme with the given name is already
 * registered on the passed surface's registry. The underlying
 * `@asteasolutions/zod-to-openapi` registry silently overwrites
 * duplicates; this guard makes that failure class loud.
 */
function guardDuplicateSchemeRegistration<E extends Env>(app: OpenAPIHono<E>, name: string): void {
  const definitions = (
    app.openAPIRegistry as unknown as {
      definitions: Array<{
        type: 'schema' | 'component' | 'route' | 'parameter' | 'webhook'
        componentType?: string
        name?: string
      }>
    }
  ).definitions
  for (const def of definitions) {
    if (def.type === 'component' && def.componentType === 'securitySchemes' && def.name === name) {
      throw new Error(
        `[openapi] Duplicate security scheme registration: '${name}' is already registered on this surface. ` +
          'Two surfaces (dashboard / control / agent) must not share an OpenAPIHono registry.'
      )
    }
  }
}
