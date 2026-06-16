import { afterEach, describe, expect, it } from 'bun:test'

import { CampaignDetailPage } from '../../src/pages/campaign-detail'
import { useAuthStore } from '../../src/stores/auth'
import { useUiStore } from '../../src/stores/ui'
import {
  mockCampaignDetailResponse,
  mockHashListsResponse,
  mockResultsResponse,
} from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId })
}

function setAuthUser(roles: string[] = ['admin'], projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Test Project', roles }],
    hasFetchedProjects: true,
  })
}

describe('CampaignDetailPage', () => {
  it('shows loading state while fetching', () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch
      },
    } as ReturnType<typeof mockFetch>

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    expect(screen.getByText('Loading campaign...')).toBeDefined()
  })

  it('shows error when API returns 404', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/99': { status: 404, body: { error: { message: 'Not found' } } },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/99',
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
  })

  it('renders header with name, status badge, and priority badge', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { id: 1, name: 'NTLM Campaign', status: 'draft', priority: 1 },
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined()
    })

    expect(screen.getByText('draft')).toBeDefined()
    // Priority=1 renders as the "high" priority badge.
    expect(screen.getByText('high')).toBeDefined()
  })

  it('renders the task stats tiles for Total/Pending/Running/Completed/Failed', async () => {
    const data = mockCampaignDetailResponse({
      taskStats: { total: 10, pending: 2, running: 3, completed: 4, failed: 1 },
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined()
    })

    const total = screen.getByTestId('task-stat-total')
    const pending = screen.getByTestId('task-stat-pending')
    const running = screen.getByTestId('task-stat-running')
    const completed = screen.getByTestId('task-stat-completed')
    const failed = screen.getByTestId('task-stat-failed')

    expect(total.textContent).toContain('10')
    expect(pending.textContent).toContain('2')
    expect(running.textContent).toContain('3')
    expect(completed.textContent).toContain('4')
    expect(failed.textContent).toContain('1')
  })

  it('renders ETA "--" when no agents are reporting speed', async () => {
    const data = mockCampaignDetailResponse({
      taskStats: { total: 10, pending: 10, running: 0, completed: 0, failed: 0 },
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined()
    })

    expect(screen.getByTestId('campaign-eta').textContent).toBe('--')
  })

  it('renders the active agents table when agents are active', async () => {
    const data = mockCampaignDetailResponse({
      activeAgents: [
        {
          agentId: 11,
          agentName: 'Rig Alpha',
          taskId: 99,
          attackId: 5,
          attackMode: 3,
          speedHs: 1500,
        },
      ],
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined()
    })

    expect(screen.getByText('Attack #5 - mode 3')).toBeDefined()
    expect(screen.getByText('1,500 H/s')).toBeDefined()
  })

  it('renders the empty state when no agents are active', async () => {
    const data = mockCampaignDetailResponse({ activeAgents: [] })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('No agents currently working on this campaign.')).toBeDefined()
    })
  })

  it('renders Start button for draft campaigns', async () => {
    const data = mockCampaignDetailResponse({ campaign: { status: 'draft' } })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Start')).toBeDefined()
    })
    // Delete is only visible in draft status.
    expect(screen.getByText('Delete')).toBeDefined()
  })

  it('renders Pause + Stop for running campaigns; no Delete', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { status: 'running', startedAt: new Date().toISOString() },
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Pause')).toBeDefined()
    })

    expect(screen.getByText('Stop')).toBeDefined()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('renders Resume + Stop for paused campaigns', async () => {
    const data = mockCampaignDetailResponse({ campaign: { status: 'paused' } })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeDefined()
    })

    expect(screen.getByText('Stop')).toBeDefined()
  })

  it('opens the stop confirmation modal when Stop is clicked', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { status: 'running', startedAt: new Date().toISOString() },
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Stop')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Stop'))

    await waitFor(() => {
      expect(screen.getByText('Stop campaign?')).toBeDefined()
    })
    expect(screen.getByText(/cancel all running tasks/i)).toBeDefined()
  })

  it('opens the delete confirmation modal when Delete is clicked on a draft campaign', async () => {
    const data = mockCampaignDetailResponse({ campaign: { status: 'draft' } })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(screen.getByText('Delete campaign?')).toBeDefined()
    })
  })

  it('fires the start lifecycle mutation without confirmation', async () => {
    const data = mockCampaignDetailResponse({ campaign: { status: 'draft' } })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1/lifecycle': {
        POST: { status: 200, body: { campaign: { ...data.campaign, status: 'running' } } },
      },
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Start')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Start'))

    await waitFor(() => {
      const calls = fetchMock.mock.calls
      const lifecycleCalls = calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/lifecycle')
      )
      expect(lifecycleCalls.length).toBeGreaterThan(0)
    })
  })

  it('renders an error banner when start mutation fails', async () => {
    const data = mockCampaignDetailResponse({ campaign: { status: 'draft' } })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1/lifecycle': {
        POST: { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } },
      },
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    setAuthUser()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Start')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Start'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
  })

  it('renders an invalid-id error when the route param is not numeric', async () => {
    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/not-a-number',
    })

    await waitFor(() => {
      expect(screen.getByText('Invalid campaign id in URL.')).toBeDefined()
    })
  })

  it('renders Back to campaigns link', async () => {
    const data = mockCampaignDetailResponse()

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter(
      [
        { path: '/campaigns/:id', element: <CampaignDetailPage /> },
        { path: '/campaigns', element: <div>Campaigns List</div> },
      ],
      { initialRoute: '/campaigns/1' }
    )

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined()
    })

    const backLink = screen.getByText('Back to campaigns')
    expect(backLink.closest('a')?.getAttribute('href')).toBe('/campaigns')
  })

  it('renders attacks table with details', async () => {
    const data = mockCampaignDetailResponse({
      attacks: [
        { id: 1, mode: 0, status: 'pending', wordlistId: 5, dependencies: [2, 3] },
        { id: 2, mode: 3, status: 'running', wordlistId: null },
      ],
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('pending')).toBeDefined()
    })

    expect(screen.getByText('running')).toBeDefined()
    expect(screen.getByText('#5')).toBeDefined()
    expect(screen.getByText('2, 3')).toBeDefined()
  })

  it('renders Keyspace + ETA columns with distinct empty states (issue #99)', async () => {
    const data = mockCampaignDetailResponse({
      attacks: [
        // Computable: formatted keyspace + a counting-down ETA.
        {
          id: 1,
          mode: 0,
          status: 'running',
          keyspace: '1000000',
          estimatedSecondsRemaining: 12000,
          wordlistId: 5,
        },
        // Count in flight: keyspace null but a wordlist is referenced.
        {
          id: 2,
          mode: 0,
          status: 'pending',
          keyspace: null,
          estimatedSecondsRemaining: null,
          wordlistId: 9,
        },
        // Exhausted, mask-only: keyspace uncomputable.
        {
          id: 3,
          mode: 3,
          status: 'exhausted',
          keyspace: null,
          estimatedSecondsRemaining: null,
          wordlistId: null,
        },
      ],
    })

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    })

    selectProject()
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    })

    await waitFor(() => {
      expect(screen.getByText('1.00e+6')).toBeDefined() // attack 1 keyspace
    })
    expect(screen.getByText('3h 20m')).toBeDefined() // attack 1 ETA (12000s)
    expect(screen.getByText('Computing...')).toBeDefined() // attack 2 keyspace, count in flight
    expect(screen.getByText('exhausted')).toBeDefined() // attack 3 status badge
  })

  describe('Results tab (U9)', () => {
    it('renders the Attacks tab by default when no ?tab= param is set', async () => {
      const data = mockCampaignDetailResponse({
        campaign: { hashListId: 1 },
        attacks: [{ id: 1, mode: 0, status: 'pending', wordlistId: 5, dependencies: null }],
      })

      fetchMock = mockFetch({
        '/dashboard/campaigns/1': { status: 200, body: data },
        '/dashboard/hash-lists': { status: 200, body: mockHashListsResponse() },
        '/dashboard/results': { status: 200, body: mockResultsResponse() },
      })

      selectProject()
      renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
        initialRoute: '/campaigns/1',
      })

      await waitFor(() => {
        // The attacks-section heading lives in the Attacks tab panel.
        expect(screen.getByText('Active agents')).toBeDefined()
      })

      // Attacks tab is active by default; the Attacks tab content
      // (Active agents heading) renders while the Results tab content
      // (stats card data-testid) does not.
      expect(screen.queryByTestId('results-stats')).toBeNull()

      // The Attacks tab trigger is aria-selected="true".
      const attacksTrigger = screen.getByRole('tab', { name: 'Attacks' })
      expect(attacksTrigger.getAttribute('aria-selected')).toBe('true')

      const resultsTrigger = screen.getByRole('tab', { name: 'Results' })
      expect(resultsTrigger.getAttribute('aria-selected')).toBe('false')
    })

    it('switches to the Results tab when the Results trigger is clicked and fires a campaign-scoped results query', async () => {
      const data = mockCampaignDetailResponse({
        campaign: { hashListId: 1 },
      })

      fetchMock = mockFetch({
        '/dashboard/campaigns/1': { status: 200, body: data },
        '/dashboard/hash-lists': {
          status: 200,
          body: mockHashListsResponse({
            hashLists: [{ id: 1, name: 'Main List', hashCount: 5000, crackedCount: 1283 }],
          }),
        },
        '/dashboard/results': {
          status: 200,
          body: mockResultsResponse({ count: 1, total: 1283 }),
        },
      })

      selectProject()
      renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
        initialRoute: '/campaigns/1',
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Results' })).toBeDefined()
      })

      fireEvent.click(screen.getByRole('tab', { name: 'Results' }))

      await waitFor(() => {
        expect(screen.getByTestId('results-stats')).toBeDefined()
      })

      // Inline stats show the campaign-scoped figures from the
      // matched hash list (5,000) and the results total (1,283).
      expect(screen.getByTestId('results-stats').textContent ?? '').toMatch(
        /1,283\s*\/\s*5,000\s*\(25\.7%\)/
      )

      // useResults must have been called with campaignId=1 so the
      // query is scoped to the current campaign rather than fetching
      // the global result set.
      await waitFor(() => {
        const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
        const scopedResults = calls.find(([url]) => {
          const s = String(url)
          return s.includes('/dashboard/results') && s.includes('campaignId=1')
        })
        expect(scopedResults).toBeDefined()
      })
    })

    it('opens directly on the Results tab when mounted with ?tab=results', async () => {
      const data = mockCampaignDetailResponse({
        campaign: { hashListId: 1 },
      })

      fetchMock = mockFetch({
        '/dashboard/campaigns/1': { status: 200, body: data },
        '/dashboard/hash-lists': { status: 200, body: mockHashListsResponse() },
        '/dashboard/results': {
          status: 200,
          body: mockResultsResponse({ count: 2, total: 250 }),
        },
      })

      selectProject()
      renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
        initialRoute: '/campaigns/1?tab=results',
      })

      await waitFor(() => {
        expect(screen.getByTestId('results-stats')).toBeDefined()
      })

      // Attacks-tab-only content is hidden when Results is active.
      expect(screen.queryByText('Active agents')).toBeNull()

      // Results trigger is aria-selected="true".
      const resultsTrigger = screen.getByRole('tab', { name: 'Results' })
      expect(resultsTrigger.getAttribute('aria-selected')).toBe('true')
    })

    it('omits the crack rate when the campaign hash list is not in the lookup response', async () => {
      const data = mockCampaignDetailResponse({
        // hashListId=999 will not match any of the two default fixtures
        // (ids 1 and 2), so `totalHashes` falls back to undefined and the
        // stats card collapses to a single cracked figure.
        campaign: { hashListId: 999 },
      })

      fetchMock = mockFetch({
        '/dashboard/campaigns/1': { status: 200, body: data },
        '/dashboard/hash-lists': { status: 200, body: mockHashListsResponse() },
        '/dashboard/results': {
          status: 200,
          body: mockResultsResponse({ count: 0, total: 42 }),
        },
      })

      selectProject()
      renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
        initialRoute: '/campaigns/1?tab=results',
      })

      await waitFor(() => {
        const stats = screen.getByTestId('results-stats')
        expect(stats.textContent ?? '').toMatch(/\b42\b/)
      })

      // The slash + percent rendering only appears when totalHashes is
      // known; absent here because the campaign's hash list is missing
      // from the lookup response.
      const stats = screen.getByTestId('results-stats')
      expect(stats.textContent ?? '').not.toMatch(/\//)
    })
  })
})
