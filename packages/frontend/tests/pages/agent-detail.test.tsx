import { afterEach, describe, expect, it } from 'bun:test'

import { AgentDetailPage } from '../../src/pages/agent-detail'
import { useUiStore } from '../../src/stores/ui'
import { mockAgentErrorsResponse, mockAgentResponse } from '../fixtures/api-responses'
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

const EMPTY_CONFIG_RESPONSE = {
  config: { tuning: {}, hardware: {}, errorWhitelist: [] },
  effective: { tuning: {}, hardware: {} },
  sources: { tuning: {}, hardware: {}, errorWhitelist: 'engine' },
}

const STANDARD_DETAIL_MOCKS = (agentId = 1) => ({
  [`/dashboard/agents/${agentId}/errors`]: { status: 200, body: { errors: [] } },
  [`/dashboard/agents/${agentId}/tasks`]: { status: 200, body: { tasks: [] } },
  [`/dashboard/agents/${agentId}/benchmarks`]: { status: 200, body: { benchmarks: [] } },
  [`/dashboard/agents/${agentId}/config`]: { status: 200, body: EMPTY_CONFIG_RESPONSE },
})

describe('AgentDetailPage', () => {
  it('shows loading state while fetching', () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch
      },
    } as ReturnType<typeof mockFetch>

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    expect(screen.getByText('Loading agent...')).toBeDefined()
  })

  it('shows not found when API returns no agent', async () => {
    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(99),
      '/dashboard/agents/99': { status: 404, body: { error: { message: 'Not found' } } },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/99',
    })

    await waitFor(() => {
      expect(screen.getByText('Agent not found.')).toBeDefined()
    })
  })

  it('renders header, status, and last-seen', async () => {
    const agentData = mockAgentResponse({
      agent: { id: 1, name: 'Rig Alpha', status: 'online' },
    })

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined()
    })

    expect(screen.getByText('online')).toBeDefined()
    expect(screen.getByText(/Last seen:/)).toBeDefined()
  })

  it('renders structured hardware profile when known shape is present', async () => {
    const agentData = mockAgentResponse({
      agent: {
        id: 1,
        name: 'Rig Alpha',
        hardwareProfile: {
          os: { name: 'Linux', version: '6.10', platform: 'x86_64' },
          cpu: { model: 'AMD Ryzen 9', cores: 32 },
          ram: { totalMb: 65536, availableMb: 32768 },
          gpus: [{ model: 'RTX 4090', memoryMb: 24576 }],
          hashcatVersion: '6.2.6',
        },
      },
    })

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined()
    })

    expect(screen.getByText('OS')).toBeDefined()
    expect(screen.getByText('Linux')).toBeDefined()
    expect(screen.getByText('CPU')).toBeDefined()
    // The GPU model renders in TWO places by design — the HardwareProfileCard
    // ("Model: RTX 4090") and the AgentConfigSection device picker (which labels
    // each detected device by its model) — so assert on all matches rather than
    // a single one.
    expect(screen.getAllByText('RTX 4090').length).toBeGreaterThan(0)
  })

  it('renders error log section with severity badges', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } })
    const errorsData = mockAgentErrorsResponse({
      errors: [
        { id: 1, severity: 'critical', message: 'GPU overheated' },
        { id: 2, severity: 'warning', message: 'Low disk space' },
      ],
    })

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1/errors': { status: 200, body: errorsData },
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Error Log')).toBeDefined()
    })

    expect(screen.getByText('GPU overheated')).toBeDefined()
    expect(screen.getByText('Low disk space')).toBeDefined()
    expect(screen.getByText('critical')).toBeDefined()
    expect(screen.getByText('warning')).toBeDefined()
  })

  it('expands error row context when toggle is clicked', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } })
    const errorsData = {
      errors: [
        {
          id: 1,
          agentId: 1,
          severity: 'critical',
          message: 'GPU overheated',
          context: { temperature: 95, gpu: 'RTX 4090' },
          createdAt: new Date().toISOString(),
        },
      ],
    }

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1/errors': { status: 200, body: errorsData },
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    await waitFor(() => {
      expect(screen.getByText('GPU overheated')).toBeDefined()
    })

    const toggle = screen.getByRole('button', { name: /expand details/i })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(screen.getByText(/temperature/i)).toBeDefined()
    })
  })

  it('renders current tasks section with empty state when no tasks', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } })

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Current Tasks')).toBeDefined()
    })

    expect(screen.getByText('No active tasks assigned.')).toBeDefined()
  })

  it('renders task rows when tasks are present', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } })
    const tasksData = {
      tasks: [
        {
          id: 50,
          campaignId: 7,
          campaignName: 'Quarterly audit',
          attackId: 9,
          attackMode: 0,
          status: 'running',
          progress: { percent: 42, speedHs: 1500000 },
          startedAt: new Date().toISOString(),
          assignedAt: new Date().toISOString(),
        },
      ],
    }

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1/tasks': { status: 200, body: tasksData },
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    })

    await waitFor(() => {
      expect(screen.getByText('Quarterly audit')).toBeDefined()
    })

    expect(screen.getByText('42%')).toBeDefined()
    expect(screen.getByText('1,500,000 H/s')).toBeDefined()
  })

  it('renders Back to agents link', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } })

    fetchMock = mockFetch({
      ...STANDARD_DETAIL_MOCKS(1),
      '/dashboard/agents/1': { status: 200, body: agentData },
    })

    selectProject()
    renderWithRouter(
      [
        { path: '/agents/:id', element: <AgentDetailPage /> },
        { path: '/agents', element: <div>Agents List</div> },
      ],
      { initialRoute: '/agents/1' }
    )

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined()
    })

    const backLink = screen.getByText('Back to agents')
    expect(backLink.closest('a')?.getAttribute('href')).toBe('/agents')
  })
})
