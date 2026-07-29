import { afterEach, describe, expect, it, mock } from 'bun:test'

import { SuperHashListDetailPage } from '../../src/pages/super-hash-list-detail'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

const DETAIL_ROUTE = { path: '/super-hash-lists/:id', element: <SuperHashListDetailPage /> }

const HASH_LISTS = [
  { id: 10, name: 'Alpha', projectId: 1 },
  { id: 20, name: 'Beta', projectId: 1 },
  { id: 30, name: 'Gamma', projectId: 1 },
]

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

/**
 * Stateful fetch double for the super detail flow. Unlike the shared
 * `mockFetch`, the member set mutates in response to add/remove calls so a
 * post-invalidation GET reflects the new server state — exactly what the
 * membership editor asserts.
 */
function makeStatefulFetch(initialMembers: number[]) {
  let members = [...initialMembers]
  const original = globalThis.fetch

  const detailBody = () => ({
    superHashList: {
      id: 1,
      projectId: 1,
      name: 'My Super',
      archivedAt: null,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      memberIds: [...members],
    },
  })

  const fn = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = ((init?.method as string) ?? 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/super-hash-lists/1/members')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as { hashListId: number }
      if (!members.includes(body.hashListId)) members.push(body.hashListId)
      return jsonResponse(detailBody())
    }
    const removeMatch = /\/super-hash-lists\/1\/members\/(\d+)/.exec(url)
    if (method === 'DELETE' && removeMatch) {
      const listId = Number(removeMatch[1])
      members = members.filter((m) => m !== listId)
      return jsonResponse(detailBody())
    }
    if (url.includes('/dashboard/resources/hash-lists')) {
      return jsonResponse({ hashLists: HASH_LISTS })
    }
    if (url.includes('/dashboard/super-hash-lists/1')) {
      return jsonResponse(detailBody())
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  })

  globalThis.fetch = fn as unknown as typeof fetch
  return { fn, restore: () => (globalThis.fetch = original) }
}

function setRoleWithProject(roles: string[], projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Test Project', roles }],
    hasFetchedProjects: true,
  })
  useUiStore.setState({ selectedProjectId: projectId })
}

let stateful: ReturnType<typeof makeStatefulFetch>

afterEach(() => {
  cleanupAll()
  if (stateful) stateful.restore()
})

describe('SuperHashListDetailPage', () => {
  it('adds two members and reflects the updated server membership', async () => {
    stateful = makeStatefulFetch([])
    setRoleWithProject(['admin'])
    renderWithRouter([DETAIL_ROUTE], { initialRoute: '/super-hash-lists/1' })

    // Route param comes from useParams; render under a matching route path.
    await waitFor(() => {
      expect(screen.getByText('My Super')).toBeDefined()
    })

    // Alpha, Beta, Gamma all eligible to add initially.
    fireEvent.click(await screen.findByLabelText('Add Alpha'))
    await waitFor(() => {
      expect(screen.getByLabelText('Remove Alpha')).toBeDefined()
    })

    fireEvent.click(await screen.findByLabelText('Add Beta'))
    await waitFor(() => {
      expect(screen.getByLabelText('Remove Beta')).toBeDefined()
    })

    // Both are now members (reflecting server state); no error surfaced.
    expect(screen.getByLabelText('Remove Alpha')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('removes a member and surfaces success without error', async () => {
    stateful = makeStatefulFetch([10, 20])
    setRoleWithProject(['admin'])
    renderWithRouter([DETAIL_ROUTE], { initialRoute: '/super-hash-lists/1' })

    await waitFor(() => {
      expect(screen.getByLabelText('Remove Alpha')).toBeDefined()
    })

    fireEvent.click(screen.getByLabelText('Remove Alpha'))

    await waitFor(() => {
      expect(screen.queryByLabelText('Remove Alpha')).toBeNull()
    })
    // Beta remains, and no error banner appeared.
    expect(screen.getByLabelText('Remove Beta')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hides add/remove controls for a project viewer', async () => {
    stateful = makeStatefulFetch([10, 20])
    setRoleWithProject(['viewer'])
    renderWithRouter([DETAIL_ROUTE], { initialRoute: '/super-hash-lists/1' })

    await waitFor(() => {
      // Members still render read-only (names resolved from the hash lists).
      expect(screen.getByText('Alpha')).toBeDefined()
    })
    expect(screen.queryByLabelText('Remove Alpha')).toBeNull()
    expect(screen.queryByText('Add members')).toBeNull()
    expect(screen.queryByText('Rename')).toBeNull()
  })
})
