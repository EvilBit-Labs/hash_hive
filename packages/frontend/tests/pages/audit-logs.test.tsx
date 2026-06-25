import { afterEach, describe, expect, it } from 'bun:test'

import { AuditLogsPage } from '../../src/pages/audit-logs'
import { useUiStore } from '../../src/stores/ui'
import { mockAuditLogsResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithMotion, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId })
}

/**
 * Default fetch mock: stubs the audit-logs endpoint so tests don't need to
 * enumerate every route in every case. Override via the `overrides` parameter.
 */
function defaultMocks(
  overrides: Record<
    string,
    { status?: number; body?: unknown; headers?: Record<string, string> }
  > = {}
) {
  return mockFetch({
    '/dashboard/audit-logs': { status: 200, body: mockAuditLogsResponse() },
    ...overrides,
  })
}

describe('AuditLogsPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = defaultMocks()
    renderWithMotion(<AuditLogsPage />)

    expect(screen.getByText('Select a project to view audit logs.')).toBeDefined()
  })

  it('renders audit log rows when data is returned', async () => {
    const data = mockAuditLogsResponse({
      logs: [
        {
          id: 1,
          actorType: 'user',
          actorLabel: 'alice',
          entityType: 'campaign',
          entityId: 10,
          entityLabel: 'NTLM Campaign',
          action: 'updated',
          changes: { name: { old: 'Old', new: 'New' } },
          createdAt: '2026-06-01T12:00:00.000Z',
        },
      ],
      total: 1,
    })

    fetchMock = defaultMocks({ '/dashboard/audit-logs': { status: 200, body: data } })
    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeDefined()
    })
    expect(screen.getByText('NTLM Campaign')).toBeDefined()
  })

  it('shows no-events empty state when list is empty and no filters active', async () => {
    fetchMock = defaultMocks({
      '/dashboard/audit-logs': {
        status: 200,
        body: { data: [], total: 0, limit: 50, offset: 0 },
      },
    })

    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('No audit events yet for this project.')).toBeDefined()
    })
  })

  it('shows filter-empty state with Clear filters button when filters are active and list is empty', async () => {
    fetchMock = defaultMocks({
      '/dashboard/audit-logs': {
        status: 200,
        body: { data: [], total: 0, limit: 50, offset: 0 },
      },
    })

    selectProject()
    renderWithMotion(<AuditLogsPage />, { initialRoute: '/audit-logs?action=deleted' })

    await waitFor(() => {
      expect(screen.getByText('No events match the current filters.')).toBeDefined()
    })
    expect(screen.getByText('Clear filters')).toBeDefined()
  })

  it('requests audit-logs with 30d default date window', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithMotion(<AuditLogsPage />, { initialRoute: '/audit-logs' })

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const auditCall = calls.find(([url]) => String(url).includes('/dashboard/audit-logs'))
      expect(auditCall).toBeDefined()
    })

    const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    const auditUrl = String(
      calls.find(([url]) => String(url).includes('/dashboard/audit-logs'))?.[0]
    )

    expect(auditUrl).toContain('dateFrom=')
    expect(auditUrl).toContain('dateTo=')

    const params = new URL(`http://x${auditUrl.slice(auditUrl.indexOf('?'))}`)
    const from = new Date(params.searchParams.get('dateFrom') ?? '')
    const to = new Date(params.searchParams.get('dateTo') ?? '')
    const diffDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThan(29.5)
    expect(diffDays).toBeLessThan(30.5)
  })

  it('selecting "All time" removes dateFrom/dateTo from the request', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Filter by date range')).toBeDefined()
    })

    fireEvent.change(screen.getByLabelText('Filter by date range'), {
      target: { value: 'all' },
    })

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const lastUrl = String(
        calls.filter(([url]) => String(url).includes('/dashboard/audit-logs')).at(-1)?.[0] ?? ''
      )
      expect(lastUrl).not.toContain('dateFrom=')
      expect(lastUrl).not.toContain('dateTo=')
    })
  })

  it('selecting an action filter passes action= to the request', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Filter by action')).toBeDefined()
    })

    fireEvent.change(screen.getByLabelText('Filter by action'), {
      target: { value: 'deleted' },
    })

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const filteredCall = calls.find(([url]) => String(url).includes('action=deleted'))
      expect(filteredCall).toBeDefined()
    })
  })

  it('uses 50-row pagination with Previous disabled on the first page', async () => {
    fetchMock = defaultMocks({
      '/dashboard/audit-logs': {
        status: 200,
        body: mockAuditLogsResponse({ logs: Array(2).fill({}), total: 120 }),
      },
    })

    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText(/1-50 of 120/)).toBeDefined()
    })

    const prev = screen.getByText('Previous') as HTMLButtonElement
    expect(prev.disabled).toBe(true)

    const next = screen.getByText('Next') as HTMLButtonElement
    expect(next.disabled).toBe(false)
  })

  it('clicking Next increments offset by 50', async () => {
    fetchMock = defaultMocks({
      '/dashboard/audit-logs': {
        status: 200,
        body: mockAuditLogsResponse({ logs: Array(2).fill({}), total: 120 }),
      },
    })

    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('Next')).toBeDefined()
    })

    fireEvent.click(screen.getByText('Next'))

    await waitFor(() => {
      expect(screen.getByText(/51-100 of 120/)).toBeDefined()
    })

    const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    const offsetCall = calls.find(([url]) => String(url).includes('offset=50'))
    expect(offsetCall).toBeDefined()
  })

  it('renders status_changed action inline without expand button', async () => {
    const data = mockAuditLogsResponse({
      logs: [
        {
          id: 5,
          action: 'status_changed',
          fromStatus: 'paused',
          toStatus: 'running',
          changes: null,
          entityType: 'campaign',
          entityId: 1,
        },
      ],
      total: 1,
    })

    fetchMock = defaultMocks({ '/dashboard/audit-logs': { status: 200, body: data } })
    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('paused')).toBeDefined()
    })
    expect(screen.getByText('running')).toBeDefined()
    // No expand button for status_changed
    expect(screen.queryByRole('button', { name: /field changed/i })).toBeNull()
  })

  it('renders token_issued action as static label', async () => {
    const data = mockAuditLogsResponse({
      logs: [
        {
          id: 6,
          action: 'token_issued',
          changes: null,
          entityType: 'agent',
          entityId: 2,
        },
      ],
      total: 1,
    })

    fetchMock = defaultMocks({ '/dashboard/audit-logs': { status: 200, body: data } })
    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('Token issued — no field diff')).toBeDefined()
    })
  })

  it('expands and collapses field diff accordion on click', async () => {
    const data = mockAuditLogsResponse({
      logs: [
        {
          id: 7,
          action: 'updated',
          changes: {
            name: { old: 'Alpha', new: 'Beta' },
            priority: { old: 3, new: 5 },
          },
          entityType: 'campaign',
          entityId: 3,
        },
      ],
      total: 1,
    })

    fetchMock = defaultMocks({ '/dashboard/audit-logs': { status: 200, body: data } })
    selectProject()
    renderWithMotion(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /fields changed/i })).toBeDefined()
    })

    const toggleBtn = screen.getByRole('button', { name: /fields changed/i })
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')

    // Expand
    fireEvent.click(toggleBtn)

    await waitFor(() => {
      expect(screen.getByText('name')).toBeDefined()
    })
    expect(screen.getByText('Alpha')).toBeDefined()
    expect(screen.getByText('Beta')).toBeDefined()
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')

    // Collapse — verify via aria-expanded (DOM removal depends on animation lifecycle)
    fireEvent.click(toggleBtn)

    await waitFor(() => {
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    })
  })

  it('passes entityType and entityId from URL deep link to the request', async () => {
    fetchMock = defaultMocks()
    selectProject()
    renderWithMotion(<AuditLogsPage />, {
      initialRoute: '/audit-logs?entityType=campaign&entityId=42',
    })

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
      const deepCall = calls.find(([url]) => {
        const s = String(url)
        return s.includes('entityType=campaign') && s.includes('entityId=42')
      })
      expect(deepCall).toBeDefined()
    })
  })
})
