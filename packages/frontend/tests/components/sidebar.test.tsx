import { afterEach, describe, expect, it, mock } from 'bun:test'

let mockSession: { user: { id: number; email: string } } | null = {
  user: { id: 1, email: 'admin@hashhive.local' },
}

mock.module('../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: mockSession, isPending: false, error: null }),
    signOut: mock(async () => ({ data: null, error: null })),
  },
}))

import { Sidebar } from '../../src/components/features/sidebar'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  mockSession = { user: { id: 1, email: 'admin@hashhive.local' } }
})

function seedTwoProjects() {
  useAuthStore.setState({
    projects: [
      { projectId: 1, projectName: 'Alpha', roles: ['admin'] },
      { projectId: 2, projectName: 'Bravo', roles: ['operator'] },
    ],
    hasFetchedProjects: true,
  })
  useUiStore.setState({ selectedProjectId: 1, sidebarOpen: true })
}

describe('Sidebar project switcher', () => {
  it('POSTs /projects/select when the dropdown value changes', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    seedTwoProjects()

    renderWithRouter([{ path: '/', element: <Sidebar /> }])

    const select = screen.getByLabelText('Select project') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '2' } })

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(2)
    })

    const call = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      return url.includes('/dashboard/projects/select')
    })
    expect(call).toBeDefined()
    const init = call?.[1] as RequestInit | undefined
    expect(JSON.parse(init?.body as string)).toEqual({ projectId: 2 })
  })

  it('treats the empty "All Projects" option as a no-op', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })
    seedTwoProjects()

    renderWithRouter([{ path: '/', element: <Sidebar /> }])

    const select = screen.getByLabelText('Select project') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '' } })

    // No request should be issued for the All Projects option
    await new Promise((r) => setTimeout(r, 10))
    const calls = fetchMock.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      return url.includes('/dashboard/projects/select')
    })
    expect(calls.length).toBe(0)
    expect(useUiStore.getState().selectedProjectId).toBe(1)
  })
})
