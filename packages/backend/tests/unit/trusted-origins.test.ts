/**
 * Pure-function coverage for `parseTrustedOrigins` and `originsToHosts`
 * in `src/lib/trusted-origins.ts`. The helper is the single source of
 * truth for the three same-origin enforcement sites (BetterAuth
 * trustedOrigins, csrf middleware, /projects/select); these tests pin
 * the parsing invariants so the sites can't drift.
 *
 * Module-level env behavior (dev allowlist active + prod gate returns
 * `[]`) is exercised in `trusted-origins-prod.test.ts` (isolated, with
 * `NODE_ENV='production'`) and through `middleware/csrf.test.ts` (dev
 * branch under `NODE_ENV='test'`).
 */
import { describe, expect, it } from 'bun:test'

import { originsToHosts, parseTrustedOrigins } from '../../src/lib/trusted-origins.js'

describe('parseTrustedOrigins', () => {
  it('returns [] for undefined or empty input', () => {
    expect(parseTrustedOrigins(undefined)).toEqual([])
    expect(parseTrustedOrigins('')).toEqual([])
  })

  it('parses a single origin', () => {
    expect(parseTrustedOrigins('http://localhost:3400')).toEqual(['http://localhost:3400'])
  })

  it('parses comma-separated origins and trims whitespace', () => {
    expect(
      parseTrustedOrigins('http://localhost:3400, https://app.test ,http://x.test:5000')
    ).toEqual(['http://localhost:3400', 'https://app.test', 'http://x.test:5000'])
  })

  it('drops empty entries from trailing or doubled commas', () => {
    expect(parseTrustedOrigins('http://localhost:3400,,')).toEqual(['http://localhost:3400'])
    expect(parseTrustedOrigins(',http://localhost:3400, ,')).toEqual(['http://localhost:3400'])
  })

  it('throws when an entry is missing the scheme', () => {
    // `new URL('localhost:3400')` parses without throwing, with
    // protocol='localhost:'; the unsupported-protocol gate catches it.
    expect(() => parseTrustedOrigins('localhost:3400')).toThrow(/BETTER_AUTH_TRUSTED_ORIGINS/)
  })

  it('throws when an entry uses an unsupported protocol', () => {
    expect(() => parseTrustedOrigins('ftp://example.com')).toThrow(
      /BETTER_AUTH_TRUSTED_ORIGINS entry .* must use http\(s\)/
    )
    expect(() => parseTrustedOrigins('file:///tmp/x')).toThrow(
      /BETTER_AUTH_TRUSTED_ORIGINS entry .* must use http\(s\)/
    )
  })

  it('throws when an entry is unparseable as a URL', () => {
    expect(() => parseTrustedOrigins('::: not a url :::')).toThrow(
      /BETTER_AUTH_TRUSTED_ORIGINS .* invalid entry/
    )
  })

  it('throws on the first bad entry even when good entries precede it', () => {
    expect(() => parseTrustedOrigins('http://localhost:3400, not-a-url')).toThrow(/not-a-url/)
  })
})

describe('originsToHosts', () => {
  it('strips scheme and path, keeping host:port', () => {
    expect(
      originsToHosts(['http://localhost:3400', 'https://app.test', 'http://x.test:5000/sub/path'])
    ).toEqual(['localhost:3400', 'app.test', 'x.test:5000'])
  })

  it('returns [] for an empty list', () => {
    expect(originsToHosts([])).toEqual([])
  })
})
