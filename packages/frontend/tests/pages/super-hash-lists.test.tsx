import { afterEach, describe, expect, it } from 'bun:test'

import { SuperHashListsPage } from '../../src/pages/super-hash-lists'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils'

function setRoleWithProject(roles: string[], projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Test Project', roles }],
    hasFetchedProjects: true,
  })
  useUiStore.setState({ selectedProjectId: projectId })
}

function superRow(over: Partial<{ id: number; name: string; archivedAt: string | null }> = {}) {
  return {
    id: over.id ?? 1,
    projectId: 1,
    name: over.name ?? 'Q3 Domain Dumps',
    archivedAt: over.archivedAt ?? null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  }
}

function listBody(rows: ReturnType<typeof superRow>[]) {
  return { superHashLists: rows, total: rows.length, limit: 50, offset: 0 }
}

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

describe('SuperHashListsPage', () => {
  it('lists the project super hash lists', async () => {
    fetchMock = mockFetch({
      '/dashboard/super-hash-lists': {
        GET: { status: 200, body: listBody([superRow({ id: 7, name: 'NTLM Union' })]) },
      },
    })
    setRoleWithProject(['admin'])
    renderWithProviders(<SuperHashListsPage />)

    await waitFor(() => {
      expect(screen.getByText('NTLM Union')).toBeDefined()
    })
  })

  it('lets an admin open the create dialog and POST a new super', async () => {
    fetchMock = mockFetch({
      // Members/detail POST target — registered first so the create POST matches
      // it before the base list GET on the same substring is considered.
      '/dashboard/super-hash-lists': {
        GET: { status: 200, body: listBody([]) },
        POST: {
          status: 201,
          body: { superHashList: { ...superRow({ id: 9, name: 'Fresh Super' }), memberIds: [] } },
        },
      },
    })
    setRoleWithProject(['admin'])
    renderWithProviders(<SuperHashListsPage />)

    await waitFor(() => {
      expect(screen.getByText('New Super Hash List')).toBeDefined()
    })
    fireEvent.click(screen.getByText('New Super Hash List'))

    const nameInput = await screen.findByLabelText('Name')
    fireEvent.change(nameInput, { target: { value: 'Fresh Super' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) =>
          (init as RequestInit | undefined)?.method === 'POST' &&
          typeof (init as RequestInit).body === 'string' &&
          ((init as RequestInit).body as string).includes('Fresh Super')
      )
      expect(postCall).toBeDefined()
    })
  })

  it('hides mutate controls for a project viewer', async () => {
    fetchMock = mockFetch({
      '/dashboard/super-hash-lists': {
        GET: { status: 200, body: listBody([superRow({ id: 3, name: 'Read Only Super' })]) },
      },
    })
    setRoleWithProject(['viewer'])
    renderWithProviders(<SuperHashListsPage />)

    await waitFor(() => {
      expect(screen.getByText('Read Only Super')).toBeDefined()
    })
    // Create + archive are RESOURCE_UPLOAD-gated; a viewer sees neither.
    expect(screen.queryByText('New Super Hash List')).toBeNull()
    expect(screen.queryByLabelText('Archive Read Only Super')).toBeNull()
  })

  it('shows a Load more control and total, and fetches the next page on click', async () => {
    const rowA = superRow({ id: 1, name: 'Union A' })
    const rowB = superRow({ id: 2, name: 'Union B' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = ((init?.method as string) ?? 'GET').toUpperCase()
      if (url.includes('/dashboard/super-hash-lists') && method === 'GET') {
        const isSecondPage = url.includes('offset=1')
        const body = isSecondPage
          ? { superHashLists: [rowB], total: 2, limit: 1, offset: 1 }
          : { superHashLists: [rowA], total: 2, limit: 1, offset: 0 }
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }
      return originalFetch(input, init)
    }) as typeof fetch

    try {
      setRoleWithProject(['admin'])
      renderWithProviders(<SuperHashListsPage />)

      await waitFor(() => {
        expect(screen.getByText('Union A')).toBeDefined()
      })
      expect(screen.getByText('Showing 1 of 2')).toBeDefined()
      expect(screen.queryByText('Union B')).toBeNull()

      fireEvent.click(screen.getByText('Load more'))

      await waitFor(() => {
        expect(screen.getByText('Union B')).toBeDefined()
      })
      expect(screen.getByText('Showing 2 of 2')).toBeDefined()
      // Load more disappears once every super has loaded.
      expect(screen.queryByText('Load more')).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('toggling "Show archived" refetches with showArchived=true', async () => {
    fetchMock = mockFetch({
      '/dashboard/super-hash-lists': {
        GET: { status: 200, body: listBody([superRow({ id: 4, name: 'Active Super' })]) },
      },
    })
    setRoleWithProject(['admin'])
    renderWithProviders(<SuperHashListsPage />)

    await waitFor(() => {
      expect(screen.getByText('Active Super')).toBeDefined()
    })

    fireEvent.click(screen.getByLabelText('Show archived'))

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      expect(calls.some(([url]) => String(url).includes('showArchived=true'))).toBe(true)
    })
  })
})
