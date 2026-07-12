import type { AuthMethods } from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'

export type { AuthMethods }

const QUERY_KEY = ['auth', 'methods'] as const

/**
 * Discovers which sign-in methods are enabled (U8, R20, KTD8) so the
 * login page knows whether to render the directory (AD/LDAP) option.
 * Anonymous endpoint -- safe to call before any session exists.
 *
 * On error (network failure, unexpected non-2xx) `data` stays
 * `undefined` and the login page's `authMethods?.ldap ?? false` default
 * quietly falls back to "directory disabled" -- the login page renders
 * byte-for-byte as the local-only form (R20's disabled-state contract)
 * rather than surfacing a fetch error on the one page every operator
 * must be able to reach. That silent fallback is intentional UX, but it
 * must not be silent for an operator debugging "why is the directory
 * button missing" -- the `queryFn` logs the error before rethrowing it
 * (rethrow keeps the query's own error/fail-closed contract unchanged;
 * only the logging is new).
 */
export function useAuthMethods() {
  return useQuery<AuthMethods>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      try {
        return await api.get<AuthMethods>('/dashboard/auth/methods')
      } catch (err) {
        // oxlint-disable-next-line no-console -- observability for a failure that otherwise disappears into the fail-closed "directory disabled" fallback with zero signal
        console.error('useAuthMethods: failed to load auth methods', err)
        throw err
      }
    },
  })
}
