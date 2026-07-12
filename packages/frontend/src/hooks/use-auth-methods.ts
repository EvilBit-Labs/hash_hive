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
 * must be able to reach.
 */
export function useAuthMethods() {
  return useQuery<AuthMethods>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<AuthMethods>('/dashboard/auth/methods'),
  })
}
