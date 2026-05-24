import { mock } from 'bun:test'

interface MockSession {
  user: { id: string; name: string; email: string; emailVerified: boolean; image: string | null }
  session: { id: string; userId: string; token: string; expiresAt: Date }
}

let mockSessionData: MockSession | null = null
let mockIsPending = false

/**
 * Mock the BetterAuth React client for frontend tests.
 * Must be called via mock.module() before importing components that use authClient.
 */
export function setupAuthClientMock() {
  mock.module('../../src/lib/auth-client', () => ({
    authClient: {
      useSession: () => ({
        data: mockSessionData,
        isPending: mockIsPending,
        error: null,
        refetch: mock(),
      }),
      signIn: {
        email: mock(async () => ({ data: mockSessionData, error: null })),
      },
      signOut: mock(async () => ({ data: null, error: null })),
      $Infer: {},
    },
  }))
}

/** Set the mock session to an authenticated user. */
export function setMockSession(overrides?: { id?: string; email?: string; name?: string }) {
  mockSessionData = {
    user: {
      id: overrides?.id ?? '1',
      name: overrides?.name ?? 'Test User',
      email: overrides?.email ?? 'test@hashhive.local',
      emailVerified: true,
      image: null,
    },
    session: {
      id: 'sess-1',
      userId: overrides?.id ?? '1',
      token: 'tok-1',
      expiresAt: new Date(Date.now() + 3600000),
    },
  }
}

/** Set the mock session to unauthenticated. */
export function clearMockSession() {
  mockSessionData = null
}

/** Set the mock session to pending (loading). */
export function setMockPending(pending: boolean) {
  mockIsPending = pending
}

/** Reset all mock session state. */
export function resetMockSession() {
  mockSessionData = null
  mockIsPending = false
}
