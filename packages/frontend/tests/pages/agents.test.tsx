import { afterEach, describe, expect, it } from 'bun:test';
import { AgentsPage } from '../../src/pages/agents';
import { useUiStore } from '../../src/stores/ui';
import { mockAgentsResponse } from '../fixtures/api-responses';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId });
}

describe('AgentsPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch();
    renderWithProviders(<AgentsPage />);

    expect(screen.getByText('Select a project to view agents.')).toBeDefined();
  });

  it('renders agents table when project selected and agents returned', async () => {
    const data = mockAgentsResponse({
      agents: [
        { id: 1, name: 'Rig Alpha', status: 'online' },
        { id: 2, name: 'Rig Beta', status: 'offline' },
      ],
    });

    fetchMock = mockFetch({
      '/dashboard/agents': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined();
    });

    expect(screen.getByText('Rig Beta')).toBeDefined();
    expect(screen.getByText('online')).toBeDefined();
    expect(screen.getByText('offline')).toBeDefined();
  });

  it('shows no agents message when API returns empty list', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': { status: 200, body: { agents: [], total: 0 } },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('No agents found.')).toBeDefined();
    });
  });

  it('renders filter buttons (All, Online, Offline, Error)', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': { status: 200, body: mockAgentsResponse() },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    const group = screen.getByRole('group', { name: /filter agents by status/i });
    expect(group).toBeDefined();
    expect(screen.getByRole('button', { name: 'All' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Online' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Offline' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Error' })).toBeDefined();
  });

  it('All filter button is pressed by default', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': { status: 200, body: mockAgentsResponse() },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    const allButton = screen.getByRole('button', { name: 'All' });
    expect(allButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking Online button triggers a refetch with ?status=online', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': { status: 200, body: mockAgentsResponse() },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeDefined();
    });

    const onlineButton = screen.getByRole('button', { name: 'Online' });
    fireEvent.click(onlineButton);

    await waitFor(() => {
      expect(onlineButton.getAttribute('aria-pressed')).toBe('true');
    });

    // Verify the new fetch actually carried status=online — the previous
    // assertion only checked aria-pressed, which a state/query-key decoupling
    // regression would silently pass.
    await waitFor(() => {
      const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const urls = calls
        .map((c) => c[0])
        .map((x) =>
          typeof x === 'string'
            ? x
            : x instanceof URL
              ? x.href
              : ((x as { url?: string }).url ?? '')
        );
      expect(urls.some((u) => u.includes('/dashboard/agents?status=online'))).toBe(true);
    });
  });

  it('agent name renders as a link to its detail page', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': {
        status: 200,
        body: mockAgentsResponse({
          count: 1,
          agents: [{ id: 42, name: 'Rig Gamma', status: 'online' }],
        }),
      },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('Rig Gamma')).toBeDefined();
    });

    const nameLink = screen.getByText('Rig Gamma');
    expect(nameLink.closest('a')?.getAttribute('href')).toBe('/agents/42');
  });

  it('renders error badge when agent has 24h errors', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': {
        status: 200,
        body: {
          agents: [
            {
              id: 1,
              name: 'Rig Alpha',
              status: 'online',
              lastSeenAt: new Date().toISOString(),
              projectId: 1,
              capabilities: null,
              hardwareProfile: null,
              createdAt: new Date().toISOString(),
              errorCount24h: 3,
              worstSeverity24h: 'fatal',
              currentTask: null,
            },
          ],
          total: 1,
        },
      },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined();
    });

    const badge = screen.getByRole('link', { name: /3 errors.*\(fatal\).*in last 24h/i });
    expect(badge).toBeDefined();
    expect(badge.getAttribute('href')).toBe('/agents/1#errors');
    expect(badge.className).toContain('text-destructive');
  });

  it('does not render error badge when errorCount24h is 0', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': {
        status: 200,
        body: {
          agents: [
            {
              id: 1,
              name: 'Rig Alpha',
              status: 'online',
              lastSeenAt: new Date().toISOString(),
              projectId: 1,
              capabilities: null,
              hardwareProfile: null,
              createdAt: new Date().toISOString(),
              errorCount24h: 0,
              worstSeverity24h: null,
              currentTask: null,
            },
          ],
          total: 1,
        },
      },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined();
    });

    // Use role/name so we assert the absence of the badge link itself, not
    // merely the absence of any DOM node containing the phrase — a future
    // tooltip or aria-describedby string containing the same phrase would
    // false-pass a text query.
    expect(screen.queryByRole('link', { name: /errors in last 24h/i })).toBeNull();
  });

  it('renders GPU count when hardwareProfile.gpus is populated', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': {
        status: 200,
        body: {
          agents: [
            {
              id: 1,
              name: 'Rig Alpha',
              status: 'online',
              lastSeenAt: new Date().toISOString(),
              projectId: 1,
              capabilities: null,
              hardwareProfile: { gpus: [{ model: 'RTX 4090' }, { model: 'RTX 4090' }] },
              createdAt: new Date().toISOString(),
              errorCount24h: 0,
              worstSeverity24h: null,
              currentTask: null,
            },
          ],
          total: 1,
        },
      },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText('Rig Alpha')).toBeDefined();
    });

    expect(screen.getByText('2 GPUs')).toBeDefined();
  });

  it('renders current task summary when assigned', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents': {
        status: 200,
        body: {
          agents: [
            {
              id: 1,
              name: 'Rig Alpha',
              status: 'busy',
              lastSeenAt: new Date().toISOString(),
              projectId: 1,
              capabilities: null,
              hardwareProfile: null,
              createdAt: new Date().toISOString(),
              errorCount24h: 0,
              worstSeverity24h: null,
              currentTask: {
                id: 100,
                campaignId: 5,
                campaignName: 'Quarterly audit',
                attackId: 9,
                attackMode: 0,
                status: 'running',
              },
            },
          ],
          total: 1,
        },
      },
    });

    selectProject();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Quarterly audit/)).toBeDefined();
    });
  });
});
