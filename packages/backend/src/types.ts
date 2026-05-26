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
  }
}
