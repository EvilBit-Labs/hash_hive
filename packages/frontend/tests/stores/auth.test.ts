import { afterEach, describe, expect, it, mock } from 'bun:test'

import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockMeResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { resetAllStores } from '../utils/store-reset'

const ME_ROUTE = '/dashboard/auth/me'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  if (fetchMock) restoreFetch(fetchMock)
  resetAllStores()
})

describe('useAuthStore.fetchProjects', () => {
  it('hydrates projects and syncs the server-selected project on success', async () => {
    fetchMock = mockFetch({
      [ME_ROUTE]: { status: 200, body: mockMeResponse({ projectCount: 2, selectedProjectId: 2 }) },
    })

    await useAuthStore.getState().fetchProjects()

    const { projects, hasFetchedProjects } = useAuthStore.getState()
    expect(hasFetchedProjects).toBe(true)
    expect(projects).toHaveLength(2)
    expect(projects[0]).toMatchObject({ projectId: 1, projectName: 'Project 1', roles: ['admin'] })
    // The server's selection is authoritative and wins over the local store.
    expect(useUiStore.getState().selectedProjectId).toBe(2)
  })

  it('auto-selects the only project when the server has not pre-selected one', async () => {
    fetchMock = mockFetch({
      [ME_ROUTE]: {
        status: 200,
        body: mockMeResponse({ projectCount: 1, selectedProjectId: null }),
      },
    })

    await useAuthStore.getState().fetchProjects()

    expect(useUiStore.getState().selectedProjectId).toBe(1)
    expect(useAuthStore.getState().hasFetchedProjects).toBe(true)
  })

  it('flags the fetch complete and clears selection on failure so route guards never hang', async () => {
    // The no-hang guarantee ProtectedRoute depends on: a /me failure must still
    // set hasFetchedProjects:true (and clear any stale selection) rather than
    // leaving the guard spinning on the loading state forever.
    const consoleSpy = mock(() => {})
    const originalConsoleError = console.error
    console.error = consoleSpy as unknown as typeof console.error

    try {
      useUiStore.setState({ selectedProjectId: 5 })
      fetchMock = mockFetch({
        [ME_ROUTE]: { status: 500, body: { error: { code: 'ERR', message: 'boom' } } },
      })

      await useAuthStore.getState().fetchProjects()

      const { projects, hasFetchedProjects } = useAuthStore.getState()
      expect(hasFetchedProjects).toBe(true)
      expect(projects).toEqual([])
      expect(useUiStore.getState().selectedProjectId).toBeNull()
      // Failure is logged, not silently swallowed.
      expect(consoleSpy).toHaveBeenCalled()
    } finally {
      console.error = originalConsoleError
    }
  })
})

describe('useAuthStore.clearAuth', () => {
  it('resets projects, the fetched flag, and the selected project', () => {
    useAuthStore.setState({
      projects: [{ projectId: 1, projectName: 'Project 1', roles: ['admin'] }],
      hasFetchedProjects: true,
    })
    useUiStore.setState({ selectedProjectId: 1 })

    useAuthStore.getState().clearAuth()

    expect(useAuthStore.getState().projects).toEqual([])
    expect(useAuthStore.getState().hasFetchedProjects).toBe(false)
    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })
})
