import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { mockCampaignsResponse } from '../fixtures/api-responses';
import { resetMockSession, setMockSession, setupAuthClientMock } from '../mocks/auth-client';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { installMockWebSocket } from '../mocks/websocket';
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils';

// authClient is mocked at the module level so useEvents (transitively
// imported by CampaignsPage) sees the test session and opens a WS.
setupAuthClientMock();
const { CampaignsPage } = await import('../../src/pages/campaigns');

let fetchMock: ReturnType<typeof mockFetch>;
let wsMock: ReturnType<typeof installMockWebSocket>;

beforeEach(() => {
  wsMock = installMockWebSocket();
});

afterEach(() => {
  cleanupAll();
  resetMockSession();
  if (fetchMock) restoreFetch(fetchMock);
  if (wsMock) wsMock.restore();
});

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId });
}

function setAuthUser(roles: string[] = ['admin'], projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Test Project', roles }],
    hasFetchedProjects: true,
  });
}

describe('CampaignsPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch();
    renderWithProviders(<CampaignsPage />);

    expect(screen.getByText('Select a project to view campaigns.')).toBeDefined();
  });

  it('renders campaigns table when project selected and campaigns returned', async () => {
    const data = mockCampaignsResponse({
      campaigns: [
        { id: 1, name: 'NTLM Campaign', status: 'running', priority: 10 },
        { id: 2, name: 'WPA Campaign', status: 'draft', priority: 5 },
      ],
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined();
    });

    expect(screen.getByText('WPA Campaign')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
    expect(screen.getByText('draft')).toBeDefined();
  });

  it('shows no campaigns message when API returns empty list', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: { campaigns: [], total: 0 } },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('No campaigns found.')).toBeDefined();
    });
  });

  it('renders status filter dropdown with correct options', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    const select = screen.getByLabelText('Filter by campaign status') as HTMLSelectElement;
    expect(select).toBeDefined();

    const options = Array.from(select.querySelectorAll('option'));
    const values = options.map((o) => o.value);
    expect(values).toContain('draft');
    expect(values).toContain('running');
    expect(values).toContain('paused');
    expect(values).toContain('completed');
    expect(values).toContain('cancelled');
  });

  it('renders priority filter dropdown with high/normal/low options', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    const select = screen.getByLabelText('Filter by campaign priority') as HTMLSelectElement;
    expect(select).toBeDefined();

    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['', '1', '5', '10']);
  });

  it('renders sort field dropdown with createdAt/name/priority options', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    const select = screen.getByLabelText('Sort campaigns by') as HTMLSelectElement;
    expect(select).toBeDefined();

    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['createdAt', 'name', 'priority']);
  });

  function getFetchUrls(mockFn: ReturnType<typeof mockFetch>): string[] {
    return mockFn.mock.calls.map((args) => {
      const first = args[0] as unknown;
      return typeof first === 'string'
        ? first
        : first instanceof URL
          ? first.href
          : (first as Request).url;
    });
  }

  it('passes priority filter through to the API', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Campaign 1')).toBeDefined();
    });

    const select = screen.getByLabelText('Filter by campaign priority');
    fireEvent.change(select, { target: { value: '1' } });

    await waitFor(() => {
      expect(getFetchUrls(fetchMock).some((u) => u.includes('priority=1'))).toBe(true);
    });
  });

  it('passes sort + order through to the API', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Campaign 1')).toBeDefined();
    });

    const sortSelect = screen.getByLabelText('Sort campaigns by');
    fireEvent.change(sortSelect, { target: { value: 'name' } });

    const orderButton = screen.getByLabelText(/Toggle sort order/);
    fireEvent.click(orderButton);

    await waitFor(() => {
      const urls = getFetchUrls(fetchMock);
      // Assert both params land on the same request — separate
      // `.some()` checks would pass even if sort and order ended up
      // in different fetch calls during state transitions.
      expect(urls.some((u) => u.includes('sort=name') && u.includes('order=asc'))).toBe(true);
    });
  });

  it('renders New Campaign link', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    setAuthUser();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Campaign 1')).toBeDefined();
    });

    const newLink = screen.getByText('New Campaign');
    expect(newLink.closest('a')?.getAttribute('href')).toBe('/campaigns/new');
  });

  it('renders the campaign name as a link to its detail page', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 1,
          campaigns: [{ id: 7, name: 'Test Campaign', status: 'draft' }],
        }),
      },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Test Campaign')).toBeDefined();
    });

    const nameLink = screen.getByText('Test Campaign');
    expect(nameLink.closest('a')?.getAttribute('href')).toBe('/campaigns/7');
  });

  it('renders an actions menu button on each row', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 1,
          campaigns: [{ id: 7, name: 'Test Campaign', status: 'draft' }],
        }),
      },
    });

    selectProject();
    setAuthUser();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Test Campaign')).toBeDefined();
    });

    const actionsButton = screen.getByLabelText('Campaign actions');
    expect(actionsButton).toBeDefined();
  });

  it('opens the start confirmation modal when the actions menu Start is clicked', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 1,
          campaigns: [{ id: 7, name: 'Test Campaign', status: 'draft', priority: 5 }],
        }),
      },
    });

    selectProject();
    setAuthUser();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Test Campaign')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Campaign actions'));
    const startItem = await screen.findByRole('menuitem', { name: 'Start' });
    fireEvent.click(startItem);

    await waitFor(() => {
      expect(screen.getByText('Start campaign?')).toBeDefined();
    });
    // The dialog message contains the campaign name + hash list + priority.
    expect(screen.getByText(/Hash list #1/)).toBeDefined();
    expect(screen.getByText('Confirm Start')).toBeDefined();
  });

  it('renders an error banner when the delete mutation returns 409 NOT_DRAFT', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/7': {
        DELETE: {
          status: 409,
          body: { error: { code: 'NOT_DRAFT', message: 'running' } },
        },
      },
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 1,
          campaigns: [{ id: 7, name: 'Test Campaign', status: 'draft', priority: 5 }],
        }),
      },
    });

    selectProject();
    setAuthUser();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Test Campaign')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Campaign actions'));
    const deleteItem = await screen.findByRole('menuitem', { name: 'Delete' });
    fireEvent.click(deleteItem);
    const confirmButton = await screen.findByText('Delete', { selector: 'button' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    // The modal stays open so the user can see why it failed.
    expect(screen.getByText('Delete campaign?')).toBeDefined();
  });

  it('renders the priority badge for each row', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': {
        status: 200,
        body: mockCampaignsResponse({
          count: 2,
          campaigns: [
            { id: 1, name: 'High Pri', status: 'draft', priority: 1 },
            { id: 2, name: 'Low Pri', status: 'draft', priority: 10 },
          ],
        }),
      },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('High Pri')).toBeDefined();
    });

    // Scope the badge assertions to each campaign's row. Global
    // `getByText('high')` / `getByText('low')` would also match the
    // priority filter option labels in the page header.
    const highRow = screen.getByText('High Pri').closest('tr');
    const lowRow = screen.getByText('Low Pri').closest('tr');
    expect(highRow?.textContent).toContain('high');
    expect(lowRow?.textContent).toContain('low');
  });

  describe('real-time updates', () => {
    function makeListPayload(initial: { id: number; name: string; status: string }[]) {
      return mockCampaignsResponse({
        campaigns: initial.map((c) => ({
          ...c,
          priority: 5,
        })),
      });
    }

    it('refetches the campaigns list when a campaign_status event arrives', async () => {
      setMockSession();
      let fetchCount = 0;
      fetchMock = mockFetch();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.includes('/dashboard/campaigns')) {
          fetchCount++;
          const body =
            fetchCount === 1
              ? makeListPayload([{ id: 1, name: 'NTLM', status: 'draft' }])
              : makeListPayload([{ id: 1, name: 'NTLM', status: 'running' }]);
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      try {
        setAuthUser();
        selectProject();
        renderWithProviders(<CampaignsPage />);

        await waitFor(() => {
          expect(screen.getByText('draft')).toBeDefined();
        });

        const ws = wsMock.instances[0];
        expect(ws).toBeDefined();
        if (!ws) return;
        ws.simulateOpen();
        ws.simulateMessage({
          type: 'campaign_status',
          projectId: 1,
          data: { campaignId: 1, status: 'running' },
          timestamp: new Date().toISOString(),
        });

        await waitFor(() => {
          expect(screen.getByText('running')).toBeDefined();
        });
        expect(fetchCount).toBeGreaterThanOrEqual(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('ignores task_update events whose data.campaignId is null', async () => {
      setMockSession();
      let fetchCount = 0;
      fetchMock = mockFetch();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.includes('/dashboard/campaigns')) {
          fetchCount++;
          return new Response(
            JSON.stringify(makeListPayload([{ id: 1, name: 'X', status: 'draft' }])),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      try {
        setAuthUser();
        selectProject();
        renderWithProviders(<CampaignsPage />);
        await waitFor(() => {
          expect(screen.getByText('X')).toBeDefined();
        });
        const initialCount = fetchCount;

        const ws = wsMock.instances[0];
        if (!ws) return;
        ws.simulateOpen();
        // A task_update without a campaignId (system task, not campaign-bearing)
        // must NOT trigger a refetch.
        ws.simulateMessage({
          type: 'task_update',
          projectId: 1,
          data: { taskId: 99, status: 'completed' },
          timestamp: new Date().toISOString(),
        });

        // Give React Query a tick to process if it were going to.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fetchCount).toBe(initialCount);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
