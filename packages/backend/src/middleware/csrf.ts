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

// Dev-mode origin allowlist. Localhost:3000 is the canonical `just dev`
// frontend; extras come from BETTER_AUTH_TRUSTED_ORIGINS so the
// Playwright E2E suite (localhost:3400 by default) can pass the
// same-origin check without weakening prod, which always sets an
// empty list.
const DEV_TRUSTED_ORIGINS = [
  'http://localhost:3000',
  ...(env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
]

interface RequestHeaders {
  header: (k: string) => string | undefined
}

/**
 * Two-mode same-origin check.
 *
 * - `{ strict: false }` (default): both `Origin` and `Referer` absent
 *   passes. This is the right call for HTTP form posts where strict
 *   referrer-policy or older browsers may strip both, and where the
 *   SameSite=Strict session cookie is the primary CSRF defense -- a
 *   cross-origin browser request would not carry the cookie anyway,
 *   and a tool like curl that omits both headers also omits the
 *   cookie.
 * - `{ strict: true }`: both headers absent FAILS. Used for the
 *   WebSocket upgrade (`requireSameOriginForWS`) where the WS spec
 *   mandates browsers send `Origin` on the handshake. A missing
 *   Origin from a browser is anomalous; a tool that opens a raw WS
 *   connection without Origin is exactly what we want to reject.
 */
function isSameOriginRequest(req: RequestHeaders, opts: { strict: boolean }): boolean {
  const origin = req.header('origin')
  const referer = req.header('referer')
  const host = req.header('host')

  if (!origin && !referer) {
    return !opts.strict
  }

  const sourceUrl = origin ?? referer
  if (!sourceUrl) {
    return !opts.strict
  }

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
    // CSRF only matters when an attacker can attach the session cookie
    // via a cross-site request. Cookie-bearing requests get the strict
    // check (missing Origin AND Referer -> reject) -- a browser will
    // always set Origin on POST per the Fetch spec, so a cookie-bearing
    // request with neither header is anomalous and exactly the
    // SameSite-policy-drift case this middleware is meant to catch.
    // Cookieless requests skip the gate: BetterAuth will return 401
    // downstream, and there's nothing for CSRF to protect since the
    // attacker has nothing to leverage.
    const strict = !!c.req.header('cookie')
    if (!isSameOriginRequest(c.req, { strict })) {
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

/**
 * Strict same-origin guard for the WebSocket upgrade. The WS spec
 * requires browsers to send `Origin` on the upgrade handshake, so
 * unlike the HTTP variant we treat missing-Origin as a rejection
 * signal rather than allowing it. Mounted on /api/v1/dashboard/events
 * because the cookie-authenticated event stream was excluded from
 * `requireSameOrigin()` -- pre-fix, cross-origin WS upgrades from a
 * stripped-cookie browser would have only been blocked indirectly
 * via the subsequent BetterAuth session lookup failing.
 */
export function requireSameOriginForWS() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isSameOriginRequest(c.req, { strict: true })) {
      return c.json(
        {
          error: {
            code: 'CSRF_ORIGIN_MISMATCH',
            message: 'WebSocket upgrade origin does not match server origin',
          },
        },
        403
      )
    }
    return next()
  })
}
