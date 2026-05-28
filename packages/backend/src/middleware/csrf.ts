/**
 * Same-origin guard for cookie-authenticated unsafe-method requests.
 *
 * Mounted globally on the dashboard surface (which is BetterAuth
 * cookie-authenticated) for HTTP methods that mutate state. Together
 * with the session cookie's `SameSite=Strict` attribute (set in
 * lib/auth.ts), this gives belt-and-suspenders CSRF protection:
 *
 *  - SameSite=Strict prevents the browser from attaching the session
 *    cookie to cross-site top-level navigations and sub-resource
 *    requests (covers <form> POSTs, <img>/<script> for GETs).
 *  - This middleware additionally rejects requests whose Origin (or
 *    Referer when Origin is absent) does not match the request's own
 *    Host header. This covers historical browsers and any future
 *    SameSite-policy regressions, and gives a defined 403 envelope
 *    rather than a 401/silent-401 from a missing cookie.
 *
 * Production air-gapped deployments serve frontend and backend behind
 * the same reverse proxy -- same-origin is the correct invariant. Dev
 * explicitly trusts http://localhost:3000 so Vite's separate dev
 * server can call the backend.
 *
 * SAFE methods (GET, HEAD, OPTIONS) are not checked: they should be
 * idempotent and the cookie's SameSite attribute is the primary
 * defense against drive-by reads.
 *
 * Originally inlined in routes/dashboard/projects.ts for
 * POST /projects/select only; promoted to shared middleware as part
 * of the S-H4 hardening.
 */
import { createMiddleware } from 'hono/factory'

import type { AppEnv } from '../types.js'

import { env } from '../config/env.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const DEV_TRUSTED_ORIGINS = ['http://localhost:3000']

function isSameOriginRequest(req: { header: (k: string) => string | undefined }): boolean {
  const origin = req.header('origin')
  const referer = req.header('referer')
  const host = req.header('host')

  // No Origin and no Referer -- almost certainly not a browser form post;
  // could be a same-origin fetch with strict referrer-policy. Allow it
  // and rely on the SameSite=Strict cookie as the primary defense.
  // Browsers issuing cross-origin state-changing fetches will populate
  // Origin per Fetch spec.
  if (!origin && !referer) return true

  const sourceUrl = origin ?? referer
  if (!sourceUrl) return true

  let sourceHost: string
  try {
    sourceHost = new URL(sourceUrl).host
  } catch {
    return false
  }

  if (host && sourceHost === host) return true

  // Dev allowance: Vite dev server runs on a different port than the
  // backend, so same-origin would always fail. Only loosen in dev.
  if (env.NODE_ENV !== 'production' && DEV_TRUSTED_ORIGINS.includes(sourceUrl)) {
    return true
  }

  return false
}

/**
 * Reject unsafe-method requests whose Origin/Referer doesn't match the
 * request Host. Returns 403 `CSRF_ORIGIN_MISMATCH` with the dashboard
 * error envelope.
 */
export function requireSameOrigin() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      return next()
    }
    if (!isSameOriginRequest(c.req)) {
      return c.json(
        {
          error: {
            code: 'CSRF_ORIGIN_MISMATCH',
            message: 'Request origin does not match server origin',
          },
        },
        403
      )
    }
    return next()
  })
}
