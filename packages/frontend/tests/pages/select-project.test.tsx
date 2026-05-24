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

  it('selects project and redirects to /', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { status: 200, body: undefined },
    })
    setAuthenticatedUser(2)

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
