import { env } from '../config/env.js'

/**
 * Single source of truth for dev/test BetterAuth trusted-origins and the
 * matching same-origin host allowlist.
 *
 * Previously three sites (`lib/auth.ts`, `middleware/csrf.ts`,
 * `routes/dashboard/projects.ts`) each parsed `BETTER_AUTH_TRUSTED_ORIGINS`
 * independently and diverged on shape (URL strings vs hosts) and on
 * gating (the projects route also required `host startsWith 'localhost'`,
 * the middleware did not). This module consolidates the parse + prod
 * gate so the three call sites can't drift.
 *
 * Production policy is intact: both `getTrustedOrigins()` and
 * `getTrustedHosts()` return `[]` when `NODE_ENV === 'production'`,
 * regardless of what's in `BETTER_AUTH_TRUSTED_ORIGINS`.
 */

const DEV_BASE_ORIGIN = 'http://localhost:3000'

/**
 * Parse a comma-separated origin list. Validates every entry up-front:
 * a malformed origin throws so a typo in `BETTER_AUTH_TRUSTED_ORIGINS`
 * fails loudly at module load instead of silently dropping at request
 * time. Empty / undefined input returns `[]`.
 *
 * Exported so it can be unit-tested as a pure function.
 */
export function parseTrustedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw === '') return []
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  for (const entry of entries) {
    let url: URL
    try {
      url = new URL(entry)
    } catch (err) {
      throw new Error(
        `BETTER_AUTH_TRUSTED_ORIGINS contains invalid entry ${JSON.stringify(entry)}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `BETTER_AUTH_TRUSTED_ORIGINS entry ${JSON.stringify(entry)} must use http(s); got ${url.protocol}`
      )
    }
  }
  return entries
}

/**
 * Convert an origin list to a host list (`new URL(o).host`). All inputs
 * must have already passed `parseTrustedOrigins`; callers should not
 * pass arbitrary strings here.
 */
export function originsToHosts(origins: readonly string[]): readonly string[] {
  return origins.map((origin) => new URL(origin).host)
}

// Module-level eager validation: typos in BETTER_AUTH_TRUSTED_ORIGINS
// throw here, before any HTTP server starts. Production reads the same
// env field but the `getTrustedOrigins()` gate below returns `[]`
// regardless, so a misconfigured prod env can't accidentally weaken
// the policy.
const PARSED_EXTRAS = parseTrustedOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS)

/**
 * Dev/test trusted-origin URL strings (e.g., `http://localhost:3000`).
 * Passed verbatim to BetterAuth's `trustedOrigins`. Returns `[]` in
 * production.
 */
export function getTrustedOrigins(): readonly string[] {
  if (env.NODE_ENV === 'production') return []
  return [DEV_BASE_ORIGIN, ...PARSED_EXTRAS]
}

/**
 * Dev/test trusted-origin hosts (e.g., `localhost:3000`). Used by the
 * same-origin middleware which compares against the parsed `host` of
 * the request's Origin/Referer header. Returns `[]` in production.
 */
export function getTrustedHosts(): readonly string[] {
  if (env.NODE_ENV === 'production') return []
  return originsToHosts(getTrustedOrigins())
}
