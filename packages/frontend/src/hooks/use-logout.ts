import { useNavigate } from 'react-router'

import { authClient } from '../lib/auth-client'
import { useAuthStore } from '../stores/auth'

/**
 * Sign the user out and route them to `/login`.
 *
 * The redirect is explicit (not a side-effect of ProtectedRoute
 * re-rendering) so the hook is safe to call from a non-protected page
 * — for example a future top-right user menu or the Account page.
 *
 * If `signOut()` rejects we still clear the local auth state and
 * navigate. A failed signOut shouldn't strand the user on a now-broken
 * session that the rest of the UI thinks is valid.
 */
export function useLogout(): () => Promise<void> {
  const navigate = useNavigate()
  return async () => {
    try {
      await authClient.signOut()
    } catch {
      // Intentionally swallow -- we still want to clear local state
      // and route to /login. The user will re-authenticate on the
      // next request.
    }
    useAuthStore.getState().clearAuth()
    void navigate('/login', { replace: true })
  }
}
