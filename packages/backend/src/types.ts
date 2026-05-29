import type { UserRole } from '@hashhive/shared'

export type AppEnv = {
  Variables: {
    requestId: string
    currentUser: {
      userId: number
      email: string
      // Global capability tier from users.roles. Mirrors the shared
      // sessionUserSchema. Populated by both requireSession (cookie
      // session reads users.roles via BetterAuth) and requireApiKey
      // (control API reads users.roles directly).
      roles: UserRole[]
      // Server-managed project scope. On the dashboard surface this is
      // sourced from session.session.projectId (issue #159 U4); on the
      // control API surface it's parsed from the X-Project-Id header.
      projectId: number | null
    }
    agent: {
      agentId: number
      projectId: number
      capabilities: Record<string, unknown>
    }
    // Per-request membership cache. Populated by checkMembership the
    // first time a project-scoped guard runs; reused by any later guard
    // (requireProjectAccess, requireMembershipRole, requireParamProjectAccess)
    // OR by route handlers that re-fetch via findProjectMembership.
    // Keyed by projectId so the param-project variant doesn't return a
    // stale session-project membership when the param differs.
    membership?: {
      projectId: number
      userId: number
      roles: string[]
    }
  }
}
