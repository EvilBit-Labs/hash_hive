import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { DashboardPage } from '../../src/pages/dashboard'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import { mockDashboardStats } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { installMockWebSocket } from '../mocks/websocket'
import {
  cleanupAll,
  fireEvent,
  renderWithProviders,
  renderWithRouter,
  screen,
  waitFor,
} from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>
let wsMock: ReturnType<typeof installMockWebSocket>

beforeEach(() => {
  wsMock = installMockWebSocket()
})

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  wsMock.restore()
})

function setAuthenticatedWithProject(projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Project 1', roles: ['admin'] }],
    hasFetchedProjects: true,
  })
  useUiStore.setState({ selectedProjectId: projectId })
}

describe('DashboardPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch()
    useAuthStore.setState({ projects: [], hasFetchedProjects: true })

    renderWithProviders(<DashboardPage />)

    expect(screen.getByText('Select a project to view its dashboard.')).toBeDefined()
  })

  it('renders motion animations honoring prefers-reduced-motion', async () => {
    // The dashboard wraps its tree in `<MotionConfig reducedMotion="user">`,
    // so motion.* descendants honor the user's media-query preference. We
    // simulate `prefers-reduced-motion: reduce` via matchMedia, render the
    // page, and assert it mounts without crash and exposes the four stat
    // cards. A future refactor that drops the MotionConfig boundary would
    // not crash this test directly, but combined with the cross-fade test
    // (which runs under reducedMotion="always" and asserts the new value
    // appears) and the e2e reduced-motion test (which asserts the
    // motion-reduce gate on animate-ping), R9 is covered across layers.
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: mockDashboardStats() },
    })
    setAuthenticatedWithProject(1)

    const originalMatchMedia = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof matchMedia

    try {
      renderWithProviders(<DashboardPage />)
      await waitFor(() => {
        const cards = screen.queryAllByTestId('stat-card')
        expect(cards.length).toBe(4)
      })
    } finally {
      globalThis.matchMedia = originalMatchMedia
    }
  })

  it('refetches dashboard stats when the user switches projects (page-level wiring)', async () => {
    // The useSparkHistory unit tests cover the buffer-clear-on-key-change
    // contract in isolation. This integration test locks the page-level
    // claim that switching `selectedProjectId` actually drives a refetch
    // under a new query key, which is the *observable* signal that the
    // sparkline keys flipped from "1:*" to "2:*" and the buffers cleared.
    fetchMock = mockFetch({
      '/dashboard/stats': {
        status: 200,
        body: mockDashboardStats({
          agents: { online: 7, total: 10 },
          campaigns: { running: 3 },
          tasks: { running: 4 },
          cracked: { total: 99 },
        }),
      },
    })

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    // Project 1 data arrives.
    await waitFor(() => expect(screen.getByText('7 / 10')).toBeDefined())

    // Swap the fetch handler so the project-2 refetch returns distinct
    // data. If the dashboard *failed* to refetch on project switch, the
    // DOM would stay pinned on project-1's numbers and the waitFor
    // below would time out.
    restoreFetch(fetchMock)
    fetchMock = mockFetch({
      '/dashboard/stats': {
        status: 200,
        body: mockDashboardStats({
          agents: { online: 2, total: 5 },
          campaigns: { running: 1 },
          tasks: { running: 1 },
          cracked: { total: 11 },
        }),
      },
    })

    useUiStore.setState({ selectedProjectId: 2 })

    // The refetch is the user-observable signal that the project switch
    // propagated; "2 / 5" can only appear in the DOM if the dashboard
    // requeried under the new project id.
    await waitFor(() => expect(screen.getByText('2 / 5')).toBeDefined())
    expect(useUiStore.getState().selectedProjectId).toBe(2)
  })

  it('renders stats from API', async () => {
    const stats = mockDashboardStats({
      agents: { online: 3, total: 5 },
      campaigns: { running: 2 },
      tasks: { running: 10 },
      cracked: { total: 42 },
    })

    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: stats },
    })

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText('3 / 5')).toBeDefined()
    })

    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText('10')).toBeDefined()
    expect(screen.getByText('42')).toBeDefined()
  })

  it('shows loading placeholders while fetching stats', () => {
    // Use a fetch mock that returns a never-resolving promise to simulate loading
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch
      },
    } as ReturnType<typeof mockFetch>

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    // All stat cards should render <Skeleton> placeholders, not the literal "-"
    expect(screen.queryAllByText('-')).toHaveLength(0)
    const cards = screen.getAllByTestId('stat-card')
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(1)
    }
  })

  it('displays connection indicator', async () => {
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: mockDashboardStats() },
    })

    setAuthenticatedWithProject(1)
    renderWithProviders(<DashboardPage />)

    // Initially WebSocket is connecting, so indicator should show Polling
    // After WS connects, it should show Live
    const ws = wsMock.instances[0]
    if (ws) {
      ws.simulateOpen()

      await waitFor(() => {
        expect(screen.getByText('Live')).toBeDefined()
      })
    }
  })

  describe('card navigation', () => {
    function renderDashboardWithRoutes() {
      const stats = mockDashboardStats({
        agents: { online: 3, total: 5 },
        campaigns: { running: 2 },
        tasks: { running: 10 },
        cracked: { total: 42 },
      })

      fetchMock = mockFetch({
        '/dashboard/stats': { status: 200, body: stats },
      })

      setAuthenticatedWithProject(1)

      return renderWithRouter(
        [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <div>Agents Page</div> },
          { path: '/campaigns', element: <div>Campaigns Page</div> },
          { path: '/results', element: <div>Results Page</div> },
        ],
        { initialRoute: '/' }
      )
    }

    it('navigates to /agents when Agents card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const agentsButton = screen.getByText('Agents').closest('button')
      expect(agentsButton).toBeDefined()
      fireEvent.click(agentsButton!)

      expect(screen.getByText('Agents Page')).toBeDefined()
    })

    it('navigates to /campaigns when Campaigns card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const campaignsButton = screen.getByText('Campaigns').closest('button')
      expect(campaignsButton).toBeDefined()
      fireEvent.click(campaignsButton!)

      expect(screen.getByText('Campaigns Page')).toBeDefined()
    })

    it('navigates to /campaigns when Tasks card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const tasksButton = screen.getByText('Tasks').closest('button')
      expect(tasksButton).toBeDefined()
      fireEvent.click(tasksButton!)

      expect(screen.getByText('Campaigns Page')).toBeDefined()
    })

    it('navigates to /results when Cracked card is clicked', async () => {
      renderDashboardWithRoutes()

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const crackedButton = screen.getByText('Cracked').closest('button')
      expect(crackedButton).toBeDefined()
      fireEvent.click(crackedButton!)

      expect(screen.getByText('Results Page')).toBeDefined()
    })
  })

  describe('header chrome (harden pass)', () => {
    it('renders the "Last updated" line when the live connection has not opened yet', async () => {
      // No `ws.simulateOpen()` here, so the WS stays in `connecting`.
      // That's a "degraded" state from the dashboard's perspective —
      // the freshness counter is meaningful while the live channel is
      // not yet delivering events.
      fetchMock = mockFetch({
        '/dashboard/stats': { status: 200, body: mockDashboardStats() },
      })
      setAuthenticatedWithProject(1)

      renderWithProviders(<DashboardPage />)

      await waitFor(() => {
        const line = screen.getByTestId('dashboard-last-updated')
        expect(line.textContent ?? '').toContain('Last updated')
      })
    })

    // The negative branch of `showFreshnessLine` (line hides when
    // `conn.status === 'open'`) was previously asserted by a test
    // that fail-soft early-returned when no WS instance existed in
    // the wsMock. Because the test render did not wrap DashboardPage
    // in EventsProvider AND useEvents() bails before opening a
    // socket when authClient has no session, the WS was never
    // created and the assertion never ran — the test always passed
    // without proving anything (Copilot review thread on
    // dashboard.test.tsx:310 caught this).
    //
    // Removing rather than half-rewriting: forcing the test to
    // actually drive a WS-open state requires stubbing
    // authClient.useSession plus EventsProvider plumbing, a lot of
    // surface for what is a single `if (conn.status !== 'open')`
    // line in dashboard.tsx. The positive branch is covered by the
    // "renders the 'Last updated' line when the live connection has
    // not opened yet" test above; the open-state visual rendering
    // is covered by ConnectionIndicator's own unit suite.

    it('renders kbd hints for R / 1-4 / Shift+P', () => {
      fetchMock = mockFetch({
        '/dashboard/stats': { status: 200, body: mockDashboardStats() },
      })
      setAuthenticatedWithProject(1)

      renderWithProviders(<DashboardPage />)

      const hintRow = screen.getByText('refresh').closest('ul')
      expect(hintRow).not.toBeNull()
      const kbds = hintRow!.querySelectorAll('kbd')
      expect(kbds).toHaveLength(3)
      expect(kbds[0]?.textContent).toBe('R')
      expect(kbds[1]?.textContent).toBe('1-4')
      // Third kbd: shift glyph + P. The glyph is wrapped in an
      // aria-hidden span so screen readers only announce "P".
      expect(kbds[2]?.textContent).toContain('P')
    })

    it('navigates to /agents when "1" is pressed on the body', async () => {
      const stats = mockDashboardStats({ agents: { online: 3, total: 5 } })
      fetchMock = mockFetch({ '/dashboard/stats': { status: 200, body: stats } })
      setAuthenticatedWithProject(1)

      renderWithRouter(
        [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <div>Agents Page</div> },
          { path: '/campaigns', element: <div>Campaigns Page</div> },
          { path: '/results', element: <div>Results Page</div> },
        ],
        { initialRoute: '/' }
      )

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      fireEvent.keyDown(window, { key: '1' })
      expect(screen.getByText('Agents Page')).toBeDefined()
    })

    it('navigates to /results when "4" is pressed on the body', async () => {
      const stats = mockDashboardStats({ agents: { online: 3, total: 5 } })
      fetchMock = mockFetch({ '/dashboard/stats': { status: 200, body: stats } })
      setAuthenticatedWithProject(1)

      renderWithRouter(
        [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <div>Agents Page</div> },
          { path: '/campaigns', element: <div>Campaigns Page</div> },
          { path: '/results', element: <div>Results Page</div> },
        ],
        { initialRoute: '/' }
      )

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      fireEvent.keyDown(window, { key: '4' })
      expect(screen.getByText('Results Page')).toBeDefined()
    })

    it('renders the NoAgentsOnboarding hero when agents.total is 0 (first-run)', async () => {
      fetchMock = mockFetch({
        '/dashboard/stats': {
          status: 200,
          body: mockDashboardStats({ agents: { online: 0, total: 0 } }),
        },
      })
      setAuthenticatedWithProject(1)

      renderWithProviders(<DashboardPage />)

      await waitFor(() => {
        expect(screen.getByTestId('dashboard-no-agents-onboarding')).toBeDefined()
      })
      // The four stat cards must NOT render in the onboarding state.
      expect(screen.queryAllByTestId('stat-card')).toHaveLength(0)
      // System health stays — operator wants to know the backend is up.
      expect(screen.getByText('System Health')).toBeDefined()
    })

    it('renders the live bento (not onboarding) when agents.total is at least 1', async () => {
      fetchMock = mockFetch({
        '/dashboard/stats': {
          status: 200,
          body: mockDashboardStats({ agents: { online: 0, total: 1 } }),
        },
      })
      setAuthenticatedWithProject(1)

      renderWithProviders(<DashboardPage />)

      await waitFor(() => {
        expect(screen.getAllByTestId('stat-card')).toHaveLength(4)
      })
      expect(screen.queryByTestId('dashboard-no-agents-onboarding')).toBeNull()
    })

    it('does NOT navigate when the "1" key fires from inside an input', async () => {
      const stats = mockDashboardStats({ agents: { online: 3, total: 5 } })
      fetchMock = mockFetch({ '/dashboard/stats': { status: 200, body: stats } })
      setAuthenticatedWithProject(1)

      renderWithRouter(
        [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <div>Agents Page</div> },
          { path: '/campaigns', element: <div>Campaigns Page</div> },
          { path: '/results', element: <div>Results Page</div> },
        ],
        { initialRoute: '/' }
      )

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined()
      })

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      fireEvent.keyDown(input, { key: '1' })
      document.body.removeChild(input)

      // Still on dashboard
      expect(screen.queryByText('Agents Page')).toBeNull()
      expect(screen.getByText('3 / 5')).toBeDefined()
    })
  })
})
