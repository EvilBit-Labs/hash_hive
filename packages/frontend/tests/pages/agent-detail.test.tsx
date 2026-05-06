import { afterEach, describe, expect, it } from 'bun:test';
import { AgentDetailPage } from '../../src/pages/agent-detail';
import { useUiStore } from '../../src/stores/ui';
import { mockAgentErrorsResponse, mockAgentResponse } from '../fixtures/api-responses';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, renderWithRouter, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId });
}

describe('AgentDetailPage', () => {
  it('shows loading state while fetching', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    } as ReturnType<typeof mockFetch>;

    selectProject();
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    });

    expect(screen.getByText('Loading agent...')).toBeDefined();
  });

  it('shows not found when API returns no agent', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents/99': { status: 404, body: { error: { message: 'Not found' } } },
    });

    selectProject();
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/99',
    });

    await waitFor(() => {
      expect(screen.getByText('Agent not found.')).toBeDefined();
    });
  });

  it('renders agent details when data is available', async () => {
    const agentData = mockAgentResponse({
      agent: { id: 1, name: 'Rig Alpha', status: 'online' },
    });

    fetchMock = mockFetch({
      '/dashboard/agents/1/errors': { status: 200, body: { errors: [] } },
      '/dashboard/agents/1': { status: 200, body: agentData },
    });

    selectProject();
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    });

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined();
    });

    expect(screen.getByText('online')).toBeDefined();
    expect(screen.getByText('Hardware')).toBeDefined();
    expect(screen.getByText('Capabilities')).toBeDefined();
  });

  it('displays recent errors when present', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } });
    const errorsData = mockAgentErrorsResponse({
      errors: [
        { id: 1, severity: 'critical', message: 'GPU overheated' },
        { id: 2, severity: 'warning', message: 'Low disk space' },
      ],
    });

    fetchMock = mockFetch({
      '/dashboard/agents/1/errors': { status: 200, body: errorsData },
      '/dashboard/agents/1': { status: 200, body: agentData },
    });

    selectProject();
    renderWithRouter([{ path: '/agents/:id', element: <AgentDetailPage /> }], {
      initialRoute: '/agents/1',
    });

    await waitFor(() => {
      expect(screen.getByText('Recent Errors')).toBeDefined();
    });

    expect(screen.getByText('GPU overheated')).toBeDefined();
    expect(screen.getByText('Low disk space')).toBeDefined();
    expect(screen.getByText('critical')).toBeDefined();
    expect(screen.getByText('warning')).toBeDefined();
  });

  it('renders Back to agents link', async () => {
    const agentData = mockAgentResponse({ agent: { id: 1, name: 'Rig Alpha' } });

    fetchMock = mockFetch({
      '/dashboard/agents/1/errors': { status: 200, body: { errors: [] } },
      '/dashboard/agents/1': { status: 200, body: agentData },
    });

    selectProject();
    renderWithRouter(
      [
        { path: '/agents/:id', element: <AgentDetailPage /> },
        { path: '/agents', element: <div>Agents List</div> },
      ],
      { initialRoute: '/agents/1' }
    );

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined();
    });

    const backLink = screen.getByText('Back to agents');
    expect(backLink.closest('a')?.getAttribute('href')).toBe('/agents');
  });
});
