/**
 * Cross-surface infrastructure shared by all three OpenAPI surfaces
 * (dashboard, control, agent). Holds the `ResponseConfig` type alias
 * and the runtime duplicate-registration guard.
 *
 * Per-surface files (`./dashboard.ts`, `./control.ts`, `./agent.ts`)
 * import from here. The parent `../components.ts` re-exports
 * everything as a stable barrel for the ~30 route files that import
 * the surface APIs.
 */

import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi'
import type { Env } from 'hono'

/**
 * Typed escape hatch for the `$ref` cast. The library's `RouteConfig`
 * response shape expects an inline definition; the per-surface
 * `shared<Surface>Response` wrappers centralize the `unknown` cast.
 */
export type ResponseConfig = NonNullable<RouteConfig['responses'][string]>

/**
 * Throws when a `responses` or `securitySchemes` component with the
 * given name is already registered on the surface's registry. The
 * underlying `@asteasolutions/zod-to-openapi` registry silently
 * overwrites duplicates — that is the failure class we want to make
 * loud. Today each surface owns an isolated registry so this guard
 * fires only on misuse; tomorrow if anyone mounts an `OpenAPIHono`
 * child onto an `OpenAPIHono` parent and both register `AuthRequired`,
 * the second call dies at boot rather than shipping a spec with one
 * definition silently missing.
 */
export function guardDuplicateComponentRegistration<E extends Env>(
  app: OpenAPIHono<E>,
  componentType: 'responses' | 'securitySchemes',
  name: string
): void {
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
    if (def.type === 'component' && def.componentType === componentType && def.name === name) {
      throw new Error(
        `[openapi] Duplicate ${componentType} registration: '${name}' is already registered on this surface. ` +
          'Two surfaces (dashboard / control / agent) must not share an OpenAPIHono registry.'
      )
    }
  }
}

/**
 * Exposed for unit testing the duplicate guard. Production code paths
 * should use the per-surface `register<Surface>ResponseComponents`
 * functions instead.
 */
export { guardDuplicateComponentRegistration as _guardDuplicateComponentRegistrationForTest }
