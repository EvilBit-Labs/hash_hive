/**
 * Shared helper for dashboard routes that need the session's project
 * scope. `requireProjectAccess()` middleware sets `scopedUser` on the
 * Hono context; if a handler runs before the middleware (a mount-order
 * regression) `c.get('scopedUser')` returns undefined and the handler
 * must respond with a 500 rather than panic-throw.
 *
 * Lifted from `results.ts` and `hash-lists.ts` where the same helper
 * appeared verbatim. Future dashboard reads should import this rather
 * than re-implement.
 */
import { logger } from '../../config/logger.js'

interface ScopedContext {
  get: (key: 'scopedUser') => { projectId: number } | undefined
}

export function getScopedProjectId(
  c: ScopedContext,
  routeLabel: string
): { ok: true; projectId: number } | { ok: false } {
  const scoped = c.get('scopedUser')
  if (!scoped) {
    logger.error(
      { route: routeLabel },
      `${routeLabel}: scopedUser middleware did not run before handler — middleware order regression`
    )
    return { ok: false }
  }
  return { ok: true, projectId: scoped.projectId }
}
