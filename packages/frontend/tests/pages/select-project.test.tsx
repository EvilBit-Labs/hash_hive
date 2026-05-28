import { afterEach, describe, expect, it, mock } from 'bun:test'

let mockSession: { user: { id: number } } | null = null
let mockIsPending = false

mock.module('../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: mockSession, isPending: mockIsPending, error: null }),
    signIn: { email: mock(async () => ({ error: null })) },
    signOut: mock(async () => ({ data: null, error: null })),
  },
}))

import { SelectProjectPage } from '../../src/pages/select-project'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  mockSession = null
  mockIsPending = false
})

function setAuthenticatedUser(projectCount: number) {
  const projects = Array.from({ length: projectCount }, (_, i) => ({
    projectId: i + 1,
    projectName: `Project ${i + 1}`,
    roles: ['admin'],
  }))

  mockSession = { user: { id: 1 } }
  useAuthStore.setState({ projects, hasFetchedProjects: true })
}

describe('SelectProjectPage', () => {
  it('redirects to /login when not authenticated', () => {
    fetchMock = mockFetch()
    // mockSession defaults to null (not authenticated), mockIsPending defaults to false

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/login', element: <div>Login Page</div> },
      ],
      { initialRoute: '/select-project' }
    )

    expect(screen.getByText('Login Page')).toBeDefined()
  })

  it('redirects to / when project already selected', () => {
    fetchMock = mockFetch()
    setAuthenticatedUser(2)
    useUiStore.setState({ selectedProjectId: 1 })

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/select-project' }
    )

    expect(screen.getByText('Dashboard Home')).toBeDefined()
  })

  it('renders project list for authenticated user', () => {
    fetchMock = mockFetch()
    setAuthenticatedUser(2)

    renderWithRouter([{ path: '/select-project', element: <SelectProjectPage /> }], {
      initialRoute: '/select-project',
    })

    expect(screen.getByText('Select Project')).toBeDefined()
    expect(screen.getByText('Project 1')).toBeDefined()
    expect(screen.getByText('Project 2')).toBeDefined()
    // Roles should be displayed
    const roleTexts = screen.getAllByText('admin')
    expect(roleTexts.length).toBe(2)
  })

  it('selects project via POST /projects/select and redirects to /', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    setAuthenticatedUser(2)

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/select-project' }
    )

    // Pre-click: store is still empty (no synchronous mutation)
    expect(useUiStore.getState().selectedProjectId).toBeNull()
    fireEvent.click(screen.getByText('Project 1'))

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(1)
    })

    // Verify the request actually went out
    const call = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      return url.includes('/dashboard/projects/select')
    })
    expect(call).toBeDefined()
    const init = call?.[1] as RequestInit | undefined
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ projectId: 1 })
  })

  it('shows an error banner when /projects/select returns 403', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': {
        POST: {
          status: 403,
          body: {
            error: { code: 'RBAC_FORBIDDEN', message: 'not a member of this project' },
          },
        },
      },
    })
    setAuthenticatedUser(2)

    renderWithRouter([{ path: '/select-project', element: <SelectProjectPage /> }], {
      initialRoute: '/select-project',
    })

    fireEvent.click(screen.getByText('Project 1'))

    await waitFor(() => {
      expect(screen.getByText('not a member of this project')).toBeDefined()
    })
    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })

  it('renders the remember-last checkbox unchecked by default and toggles the store', () => {
    fetchMock = mockFetch()
    setAuthenticatedUser(2)

    renderWithRouter([{ path: '/select-project', element: <SelectProjectPage /> }], {
      initialRoute: '/select-project',
    })

    const checkbox = screen.getByLabelText(
      'Remember this project on next sign-in'
    ) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    expect(useUiStore.getState().rememberLastProject).toBe(true)
  })

  it('persists lastProjectId on success when remember-last is on', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    setAuthenticatedUser(2)
    useUiStore.setState({ rememberLastProject: true })

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/select-project' }
    )

    fireEvent.click(screen.getByText('Project 2'))

    await waitFor(() => {
      expect(useUiStore.getState().lastProjectId).toBe(2)
    })
  })

  it('does NOT persist lastProjectId when remember-last is off', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    setAuthenticatedUser(2)
    useUiStore.setState({ rememberLastProject: false })

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/select-project' }
    )

    fireEvent.click(screen.getByText('Project 1'))

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(1)
    })

    expect(useUiStore.getState().lastProjectId).toBeNull()
  })

  it('shows empty state when no projects', () => {
    fetchMock = mockFetch()
    setAuthenticatedUser(0)

    renderWithRouter([{ path: '/select-project', element: <SelectProjectPage /> }], {
      initialRoute: '/select-project',
    })

    expect(screen.getByText('No projects available. Contact an administrator.')).toBeDefined()
  })
})
