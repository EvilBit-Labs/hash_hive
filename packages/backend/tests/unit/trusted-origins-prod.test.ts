/**
 * Production-mode invariants for the trusted-origins helper.
 *
 * Mirrors `openapi-spec-cache-prod.test.ts`: `src/config/env.ts`
 * captures `NODE_ENV` at module load (`const env = loadEnv()`), so the
 * production branch of `getTrustedOrigins()` / `getTrustedHosts()` can
 * only be observed when `NODE_ENV='production'` is set BEFORE any
 * import pulls in `env.ts`. The dedicated `preload-prod.ts` does that
 * AND sets `BETTER_AUTH_TRUSTED_ORIGINS=https://evil.example.com` to
 * pin the load-bearing property: production policy MUST ignore the
 * env var regardless of its value.
 *
 * Run via:
 *
 *   TRUSTED_ORIGINS_PROD_TEST_ISOLATED=1 bun test \
 *     --preload ./tests/preload-prod.ts \
 *     tests/unit/trusted-origins-prod.test.ts
 *
 * Wired into `packages/backend/package.json`'s `test` script.
 */
import { beforeAll, describe, expect, it } from 'bun:test'

import { env } from '../../src/config/env.js'
import { getTrustedHosts, getTrustedOrigins } from '../../src/lib/trusted-origins.js'

const isIsolated = process.env['TRUSTED_ORIGINS_PROD_TEST_ISOLATED'] === '1'

describe.skipIf(!isIsolated)('trusted-origins (production mode, isolated)', () => {
  beforeAll(() => {
    // If the preload wasn't wired correctly, all assertions below
    // would silently pass against dev-mode behavior — exactly the
    // failure mode the reviewer flagged.
    expect(env.NODE_ENV).toBe('production')
    // Sanity check the preload set the hostile value; otherwise the
    // "production policy ignores extras" invariant is being tested
    // against an empty env var, not against a real attack.
    expect(env.BETTER_AUTH_TRUSTED_ORIGINS).toBe('https://evil.example.com')
  })

  it('returns [] from getTrustedOrigins even when BETTER_AUTH_TRUSTED_ORIGINS is hostile', () => {
    expect(getTrustedOrigins()).toEqual([])
  })

  it('returns [] from getTrustedHosts even when BETTER_AUTH_TRUSTED_ORIGINS is hostile', () => {
    expect(getTrustedHosts()).toEqual([])
  })

  it('does not include the dev base origin in production', () => {
    expect(getTrustedOrigins()).not.toContain('http://localhost:3000')
    expect(getTrustedHosts()).not.toContain('localhost:3000')
  })

  it('does not include the hostile extra in production', () => {
    expect(getTrustedOrigins()).not.toContain('https://evil.example.com')
    expect(getTrustedHosts()).not.toContain('evil.example.com')
  })
})
