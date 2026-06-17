import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router'

// Mock BetterAuth client before importing components
let mockSession: { user: { id: string; name: string; email: string } } | null = null
let mockIsPending = false

mock.module('../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({
      data: mockSession,
      isPending: mockIsPending,
      error: null,
    }),
  },
}))

import { ProtectedRoute } from '../../src/components/features/protected-route'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { cleanupAll, createTestQueryClient, screen } from '../test-utils'

const SESSION = { user: { id: '1', name: 'Admin', email: 'admin@hashhive.local' } }

afterEach(() => {
  cleanupAll()
  mockSession = null
  mockIsPending = false
  // Reset both stores so per-test state never leaks across cases.
  useAuthStore.setState({ projects: [], hasFetchedProjects: false })
  useUiStore.setState({ selectedProjectId: null })
})

function renderProtectedTree(initialRoute = '/') {
  const qc = createTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
            <Route path="campaigns" element={<div>Campaigns Content</div>} />
          </Route>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/select-project" element={<div>Select Project</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('ProtectedRoute', () => {
  it('redirects to /login when not authenticated', () => {
    mockSession = null
    renderProtectedTree('/')
    expect(screen.getByText('Login Page')).toBeDefined()
  })

  it('shows loading while project membership is still being fetched on a cold load', () => {
    // Hard load of a sub-route: the session has resolved but fetchProjects()
    // has not completed yet, so selectedProjectId is still null. The guard must
    // wait rather than redirect, or the requested route is lost.
    mockSession = SESSION
    useAuthStore.setState({ hasFetchedProjects: false })
    useUiStore.setState({ selectedProjectId: null })
    renderProtectedTree('/campaigns')
    expect(screen.getByText('Loading...')).toBeDefined()
    expect(screen.queryByText('Select Project')).toBeNull()
    expect(screen.queryByText('Campaigns Content')).toBeNull()
  })

  it('preserves the requested deep-link route once the project fetch resolves', () => {
    mockSession = SESSION
    useAuthStore.setState({ hasFetchedProjects: true })
    useUiStore.setState({ selectedProjectId: 1 })
    renderProtectedTree('/campaigns')
    expect(screen.getByText('Campaigns Content')).toBeDefined()
    // A redirect to "/" would have rendered the index route instead.
    expect(screen.queryByText('Protected Content')).toBeNull()
  })

  it('redirects to /select-project when the fetch is complete and no project is selected', () => {
    mockSession = SESSION
    useAuthStore.setState({ hasFetchedProjects: true })
    useUiStore.setState({ selectedProjectId: null })
    renderProtectedTree('/')
    expect(screen.getByText('Select Project')).toBeDefined()
  })

  it('falls through to /select-project after a failed fetch instead of hanging on loading', () => {
    // fetchProjects() failure sets hasFetchedProjects: true with no projects and
    // clears the selection — the guard must resolve, not spin forever.
    mockSession = SESSION
    useAuthStore.setState({ projects: [], hasFetchedProjects: true })
    useUiStore.setState({ selectedProjectId: null })
    renderProtectedTree('/')
    expect(screen.getByText('Select Project')).toBeDefined()
  })

  it('renders outlet when authenticated, fetch complete, and project selected', () => {
    mockSession = SESSION
    useAuthStore.setState({ hasFetchedProjects: true })
    useUiStore.setState({ selectedProjectId: 1 })
    renderProtectedTree('/')
    expect(screen.getByText('Protected Content')).toBeDefined()
  })

  it('shows loading state while session is pending', () => {
    mockIsPending = true
    renderProtectedTree('/')
    expect(screen.getByText('Loading...')).toBeDefined()
  })
})
