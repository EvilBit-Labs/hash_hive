import { afterEach, describe, expect, it, mock } from 'bun:test'

let mockSession: { user: { id: number } } | null = null
let signInResult: { error: { message: string } | null } = { error: null }

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
  },
}))

import { LoginPage } from '../../src/pages/login'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockMeResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  mockSession = null
  signInResult = { error: null }
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
})
