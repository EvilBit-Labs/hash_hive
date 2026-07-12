import { LDAP_SIGNIN_ERROR_CODES } from '@hashhive/shared'
import { afterEach, describe, expect, it, mock } from 'bun:test'

interface DirectorySignInError {
  status: number
  code?: string
  message?: string
  linkRequestId?: number
}

let mockSession: { user: { id: number } } | null = null
let signInResult: { error: { message: string } | null } = { error: null }
let directorySignInResult: {
  data: { token: string; user: { id: number; email: string; name: string; roles: string[] } } | null
  error: DirectorySignInError | null
} = {
  data: {
    token: 't',
    user: { id: 1, email: 'directory@lab.local', name: 'Directory', roles: ['operator'] },
  },
  error: null,
}
const sessionSignalNotify = mock(() => {})
const signInLdapMock = mock(async (_params: { username: string; password: string }) => {
  // Simulate the session-atom side effect that a real /sign-in/ldap
  // success + the manual $store.notify('$sessionSignal') call produce.
  if (!directorySignInResult.error) {
    mockSession = { user: { id: 1 } }
  }
  return directorySignInResult
})

mock.module('../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: mockSession, isPending: false, error: null }),
    signIn: {
      email: mock(async (_params: { email: string; password: string }) => {
        // Simulate BetterAuth setting the session after successful sign-in
        if (!signInResult.error) {
          mockSession = { user: { id: 1 } }
        }
        return signInResult
      }),
    },
    signOut: mock(async () => ({ data: null, error: null })),
    $store: { notify: sessionSignalNotify },
  },
  signInLdap: signInLdapMock,
}))

import { LoginPage } from '../../src/pages/login'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockMeResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

/** `/dashboard/auth/methods` route config for `mockFetch`. */
function authMethodsRoute(ldap: boolean) {
  return { '/dashboard/auth/methods': { status: 200, body: { local: true, ldap } } }
}

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  mockSession = null
  signInResult = { error: null }
  directorySignInResult = {
    data: {
      token: 't',
      user: { id: 1, email: 'directory@lab.local', name: 'Directory', roles: ['operator'] },
    },
    error: null,
  }
  sessionSignalNotify.mockClear()
  signInLdapMock.mockClear()
})

describe('LoginPage', () => {
  it('renders login form', () => {
    fetchMock = mockFetch()
    renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

    expect(screen.getByText('HashHive')).toBeDefined()
    expect(screen.getByLabelText('Email')).toBeDefined()
    expect(screen.getByLabelText('Password')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDefined()
  })

  it('shows error on invalid credentials', async () => {
    fetchMock = mockFetch()
    signInResult = { error: { message: 'Invalid email or password' } }

    renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'bad@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrongpassword' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password')).toBeDefined()
    })
  })

  it('surfaces a "failed to load projects" error instead of silently redirecting when sign-in succeeds but /dashboard/auth/me fails', async () => {
    // Regression coverage: after a successful sign-in, fetchProjects()'s
    // failure branch ALSO produces hasFetchedProjects:true +
    // selectedProjectId:null -- the exact same state the
    // "authenticated, no project auto-selected" redirect guard checks for.
    // Without gating that guard on lastFetchFailed, the redirect wins the
    // race and the user lands on /select-project with no error, exactly
    // as though they simply have zero project memberships.
    const consoleSpy = mock(() => {})
    const originalConsoleError = console.error
    console.error = consoleSpy as unknown as typeof console.error

    try {
      signInResult = { error: null }
      fetchMock = mockFetch({
        '/dashboard/auth/me': { status: 500, body: { error: { code: 'ERR', message: 'boom' } } },
      })

      renderWithRouter(
        [
          { path: '/login', element: <LoginPage /> },
          { path: '/select-project', element: <div>Select Project Page</div> },
          { path: '/', element: <div>Dashboard Home</div> },
        ],
        { initialRoute: '/login' }
      )

      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'admin@hashhive.local' },
      })
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'password123' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

      await waitFor(() => {
        expect(screen.getByText('Failed to load projects. Please try again.')).toBeDefined()
      })
      expect(screen.queryByText('Select Project Page')).toBeNull()
      expect(screen.queryByText('Dashboard Home')).toBeNull()
    } finally {
      console.error = originalConsoleError
    }
  })

  it('redirects to /select-project when multiple projects', async () => {
    const meResponse = mockMeResponse({ projectCount: 2 })
    signInResult = { error: null }
    fetchMock = mockFetch({
      '/dashboard/auth/me': { status: 200, body: meResponse },
    })

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard</div> },
      ],
      { initialRoute: '/login' }
    )

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Select Project Page')).toBeDefined()
    })
  })

  it('auto-selects project and redirects to / when single project', async () => {
    const meResponse = mockMeResponse({ projectCount: 1 })
    signInResult = { error: null }
    fetchMock = mockFetch({
      '/dashboard/auth/me': { status: 200, body: meResponse },
    })

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    )

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Dashboard Home')).toBeDefined()
    })

    expect(useUiStore.getState().selectedProjectId).toBe(1)
  })

  it('auto-selects rememberLastProject id when server has not pre-selected', async () => {
    const meResponse = mockMeResponse({ projectCount: 3, selectedProjectId: null })
    signInResult = { error: null }
    fetchMock = mockFetch({
      '/dashboard/auth/me': { status: 200, body: meResponse },
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    useUiStore.setState({ rememberLastProject: true, lastProjectId: 2 })

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    )

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Dashboard Home')).toBeDefined()
    })

    expect(useUiStore.getState().selectedProjectId).toBe(2)
    const selectCall = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      return url.includes('/dashboard/projects/select')
    })
    expect(selectCall).toBeDefined()
  })

  it('does not auto-select when rememberLastProject id is no longer in membership', async () => {
    const meResponse = mockMeResponse({ projectCount: 2, selectedProjectId: null })
    signInResult = { error: null }
    fetchMock = mockFetch({
      '/dashboard/auth/me': { status: 200, body: meResponse },
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    // Stored id 99 is not in the 2-project membership list (ids 1, 2)
    useUiStore.setState({ rememberLastProject: true, lastProjectId: 99 })

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    )

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Select Project Page')).toBeDefined()
    })

    // No POST /projects/select should have been issued
    const selectCall = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      return url.includes('/dashboard/projects/select')
    })
    expect(selectCall).toBeUndefined()
  })

  it('falls through to selector when auto-select rejects with 403', async () => {
    const meResponse = mockMeResponse({ projectCount: 2, selectedProjectId: null })
    signInResult = { error: null }
    fetchMock = mockFetch({
      '/dashboard/auth/me': { status: 200, body: meResponse },
      '/dashboard/projects/select': {
        POST: { status: 403, body: { error: { code: 'RBAC_FORBIDDEN', message: 'forbidden' } } },
      },
    })
    useUiStore.setState({ rememberLastProject: true, lastProjectId: 1 })

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    )

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(screen.getByText('Select Project Page')).toBeDefined()
    })

    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })

  it('already authenticated user redirects to /', () => {
    fetchMock = mockFetch()
    mockSession = { user: { id: 1 } }
    useAuthStore.setState({
      projects: [{ projectId: 1, projectName: 'Project 1', roles: ['admin'] }],
      hasFetchedProjects: true,
    })
    useUiStore.setState({ selectedProjectId: 1 })

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    )

    // Should immediately redirect - no login form visible
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.getByText('Dashboard Home')).toBeDefined()
  })

  describe('directory (AD/LDAP) sign-in (U8, R20, R21)', () => {
    it('renders only the local form when ldap:false (byte-for-byte unchanged, R20)', async () => {
      fetchMock = mockFetch(authMethodsRoute(false))
      renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

      // Give the auth-methods query a tick to resolve before asserting absence.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled()
      })
      expect(screen.queryByRole('button', { name: 'Sign in with Directory' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Sign In' })).toBeDefined()
    })

    it('renders only the local form and no error banner when /dashboard/auth/methods rejects (fail-closed, logged not silent)', async () => {
      const consoleSpy = mock(() => {})
      const originalConsoleError = console.error
      console.error = consoleSpy as unknown as typeof console.error

      try {
        fetchMock = mockFetch({
          '/dashboard/auth/methods': {
            status: 500,
            body: { error: { code: 'ERR', message: 'boom' } },
          },
        })
        renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

        await waitFor(() => {
          expect(consoleSpy).toHaveBeenCalled()
        })

        expect(screen.queryByRole('button', { name: 'Sign in with Directory' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Sign In' })).toBeDefined()
        expect(screen.getByLabelText('Email')).toBeDefined()
        expect(screen.getByLabelText('Password')).toBeDefined()
        // No error banner leaks the /dashboard/auth/methods failure to the user.
        expect(screen.queryByRole('alert')).toBeNull()
      } finally {
        console.error = originalConsoleError
      }
    })

    it('renders the directory option when ldap:true and reveals fields on click', async () => {
      fetchMock = mockFetch(authMethodsRoute(true))
      renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

      const trigger = await screen.findByRole('button', { name: 'Sign in with Directory' })
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByLabelText('Directory Username')).toBeNull()

      fireEvent.click(trigger)

      await waitFor(() => {
        expect(screen.getByLabelText('Directory Username')).toBeDefined()
      })
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByLabelText('Directory Password')).toBeDefined()
      // Focus moves into the revealed fields.
      expect(document.activeElement).toBe(screen.getByLabelText('Directory Username'))
      // Trigger label flips to reflect the open state.
      expect(screen.getByRole('button', { name: 'Use email & password instead' })).toBeDefined()
    })

    it('submitting the directory form posts to signInLdap and follows the same post-login flow', async () => {
      const meResponse = mockMeResponse({ projectCount: 1 })
      fetchMock = mockFetch({
        ...authMethodsRoute(true),
        '/dashboard/auth/me': { status: 200, body: meResponse },
      })
      renderWithRouter(
        [
          { path: '/login', element: <LoginPage /> },
          { path: '/select-project', element: <div>Select Project Page</div> },
          { path: '/', element: <div>Dashboard Home</div> },
        ],
        { initialRoute: '/login' }
      )

      fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Directory' }))
      fireEvent.change(await screen.findByLabelText('Directory Username'), {
        target: { value: 'jdoe' },
      })
      fireEvent.change(screen.getByLabelText('Directory Password'), {
        target: { value: 'correct-horse-battery-staple' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Directory' }))

      await waitFor(() => {
        expect(screen.getByText('Dashboard Home')).toBeDefined()
      })
      expect(signInLdapMock).toHaveBeenCalledWith({
        username: 'jdoe',
        password: 'correct-horse-battery-staple',
      })
      // Manual session-signal notify compensates for signInLdap bypassing
      // BetterAuth's built-in atomListeners matcher.
      expect(sessionSignalNotify).toHaveBeenCalledWith('$sessionSignal')
    })

    // Pins this table's `code` values against the shared catalogue
    // (@hashhive/shared's LDAP_SIGNIN_ERROR_CODES) so a rename/removal on
    // the backend side (plugin.ts's outcomeToApiError) fails this test
    // instead of silently drifting apart from login.tsx's message mapping
    // (FIX 7: shared LDAP sign-in error codes).
    const directoryErrorCodeTable = [
      [401, undefined, 'Invalid directory username or password.'],
      [
        403,
        'LDAP_NO_MAPPED_GROUP',
        'Your directory account is not a member of a group mapped to HashHive access.',
      ],
      [
        403,
        'LDAP_ROLE_SYNC_BLOCKED',
        'This directory sign-in was blocked to protect the last local administrator. Contact an admin.',
      ],
      [
        503,
        undefined,
        'The directory server is unavailable. Try again shortly, or sign in with a local account below.',
      ],
      [
        409,
        'LDAP_ACCOUNT_COLLISION',
        'This account needs an administrator to link it before you can sign in this way. Contact an admin.',
      ],
      // Unmapped status (e.g. a 429 rate-limit, or an unexpected 5xx this
      // table has no specific case for) falls to directoryErrorMessage's
      // `default:` branch, which must return a safe generic message --
      // never `err.message` verbatim (the whole point of this table's
      // "never a raw status/message leak" assertion below).
      [429, undefined, 'Directory sign-in failed. Please try again.'],
    ] as const

    it('every non-undefined code in the directory error table is a known shared LDAP sign-in error code', () => {
      const codesUnderTest = directoryErrorCodeTable
        .map(([, code]) => code)
        .filter((code): code is string => code !== undefined)

      for (const code of codesUnderTest) {
        expect(LDAP_SIGNIN_ERROR_CODES).toContain(code)
      }
    })

    it.each(directoryErrorCodeTable)(
      'surfaces the distinct typed message for a %i directory sign-in failure',
      async (status, code, expectedMessage) => {
        fetchMock = mockFetch(authMethodsRoute(true))
        directorySignInResult = { data: null, error: { status, code, message: 'raw' } }

        renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

        fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Directory' }))
        fireEvent.change(await screen.findByLabelText('Directory Username'), {
          target: { value: 'jdoe' },
        })
        fireEvent.change(screen.getByLabelText('Directory Password'), {
          target: { value: 'wrong' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Continue with Directory' }))

        await waitFor(() => {
          expect(screen.getByText(expectedMessage)).toBeDefined()
        })
        // Never a raw status/message leak.
        expect(screen.queryByText('raw')).toBeNull()
        expect(screen.queryByText(String(status))).toBeNull()
      }
    )

    it('switching from directory back to local clears the directory form validation errors', async () => {
      fetchMock = mockFetch(authMethodsRoute(true))
      renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' })

      const trigger = await screen.findByRole('button', { name: 'Sign in with Directory' })
      fireEvent.click(trigger)
      await screen.findByLabelText('Directory Username')

      // Submit empty to trigger directory-form validation errors.
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Directory' }))
      await waitFor(() => {
        expect(
          screen.getAllByText('Too small: expected string to have >=1 characters').length
        ).toBe(2)
      })

      // Close the disclosure (back to local) then reopen -- errors must
      // not persist across the switch.
      fireEvent.click(screen.getByRole('button', { name: 'Use email & password instead' }))
      await waitFor(() => {
        expect(screen.queryByLabelText('Directory Username')).toBeNull()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Directory' }))
      await screen.findByLabelText('Directory Username')

      expect(screen.queryByText('Too small: expected string to have >=1 characters')).toBeNull()
    })

    it('local sign-in stays independent of the directory path (no identifier-format guessing)', async () => {
      const meResponse = mockMeResponse({ projectCount: 1 })
      fetchMock = mockFetch({
        ...authMethodsRoute(true),
        '/dashboard/auth/me': { status: 200, body: meResponse },
      })
      signInResult = { error: null }
      renderWithRouter(
        [
          { path: '/login', element: <LoginPage /> },
          { path: '/', element: <div>Dashboard Home</div> },
        ],
        { initialRoute: '/login' }
      )

      await screen.findByRole('button', { name: 'Sign in with Directory' })

      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'admin@hashhive.local' },
      })
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'password123' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

      await waitFor(() => {
        expect(mockSession).toEqual({ user: { id: 1 } })
      })
      expect(signInLdapMock).not.toHaveBeenCalled()
    })
  })
})
