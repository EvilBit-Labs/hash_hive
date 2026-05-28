import { afterEach, describe, expect, it, mock } from 'bun:test'

const callOrder: string[] = []
const signOutMock = mock(async () => {
  callOrder.push('signOut')
  return { data: null, error: null }
})

let signOutShouldReject = false

mock.module('../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false, error: null }),
    signOut: mock(async () => {
      callOrder.push('signOut')
      if (signOutShouldReject) {
        throw new Error('signOut failed')
      }
      return { data: null, error: null }
    }),
  },
}))

import { useLogout } from '../../src/hooks/use-logout'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

afterEach(() => {
  cleanupAll()
  callOrder.length = 0
  signOutShouldReject = false
  signOutMock.mockClear()
})

function Probe() {
  const logout = useLogout()
  return (
    <button
      type="button"
      data-testid="logout"
      onClick={() => {
        void logout()
      }}
    >
      sign out
    </button>
  )
}

describe('useLogout', () => {
  it('calls signOut → clearAuth → navigate("/login") in order', async () => {
    // Seed state we can observe getting cleared
    useAuthStore.setState({
      projects: [{ projectId: 1, projectName: 'A', roles: ['admin'] }],
      hasFetchedProjects: true,
    })
    useUiStore.setState({ selectedProjectId: 1 })

    // Spy on clearAuth without replacing the real implementation -- the
    // store's clearAuth also resets the UI selection, which we want to
    // verify.
    const originalClearAuth = useAuthStore.getState().clearAuth
    const wrappedClearAuth = mock(() => {
      callOrder.push('clearAuth')
      originalClearAuth()
    })
    useAuthStore.setState({ clearAuth: wrappedClearAuth })

    renderWithRouter(
      [
        { path: '/account', element: <Probe /> },
        { path: '/login', element: <div data-testid="login-page">Login</div> },
      ],
      { initialRoute: '/account' }
    )

    fireEvent.click(screen.getByTestId('logout'))

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeDefined()
    })

    expect(callOrder).toEqual(['signOut', 'clearAuth'])
    expect(useAuthStore.getState().projects).toEqual([])
    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })

  it('still navigates to /login when signOut rejects', async () => {
    signOutShouldReject = true
    useAuthStore.setState({
      projects: [{ projectId: 1, projectName: 'A', roles: ['admin'] }],
      hasFetchedProjects: true,
    })
    useUiStore.setState({ selectedProjectId: 1 })

    renderWithRouter(
      [
        { path: '/account', element: <Probe /> },
        { path: '/login', element: <div data-testid="login-page">Login</div> },
      ],
      { initialRoute: '/account' }
    )

    fireEvent.click(screen.getByTestId('logout'))

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeDefined()
    })

    // clearAuth must still have run despite the signOut failure
    expect(useAuthStore.getState().projects).toEqual([])
    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })
})
