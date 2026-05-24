import { createAuthClient } from 'better-auth/react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BetterAuth's inferred type requires internal references that aren't portable
export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: window.location.origin,
})
