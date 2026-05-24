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
import { useUiStore } from '../../src/stores/ui'
import { cleanupAll, createTestQueryClient, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
  mockSession = null
  mockIsPending = false
})

function renderProtectedTree(initialRoute = '/') {
  const qc = createTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
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

  it('redirects to /select-project when authenticated but no project selected', () => {
    mockSession = { user: { id: '1', name: 'Admin', email: 'admin@hashhive.local' } }
    useUiStore.setState({ selectedProjectId: null })
    renderProtectedTree('/')
    expect(screen.getByText('Select Project')).toBeDefined()
  })

  it('renders outlet when authenticated and project selected', () => {
    mockSession = { user: { id: '1', name: 'Admin', email: 'admin@hashhive.local' } }
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
