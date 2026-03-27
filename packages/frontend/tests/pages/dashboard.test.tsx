import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DashboardPage } from '../../src/pages/dashboard';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { mockDashboardStats } from '../fixtures/api-responses';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { installMockWebSocket, type MockWebSocket } from '../mocks/websocket';
import {
  cleanupAll,
  fireEvent,
  renderWithProviders,
  renderWithRouter,
  screen,
  waitFor,
} from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;
let wsMock: ReturnType<typeof installMockWebSocket>;

beforeEach(() => {
  wsMock = installMockWebSocket();
});

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
  wsMock.restore();
});

function setAuthenticatedWithProject(projectId = 1) {
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    user: {
      id: 1,
      email: 'admin@hashhive.local',
      name: 'Admin',
      projects: [{ projectId, projectName: 'Project 1', roles: ['admin'] }],
    },
  });
  useUiStore.setState({ selectedProjectId: projectId });
}

describe('DashboardPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch();
    useAuthStore.setState({ isLoading: false, isAuthenticated: true, user: null });

    renderWithProviders(<DashboardPage />);

    expect(screen.getByText('Select a project to view its dashboard.')).toBeDefined();
  });

  it('renders stats from API', async () => {
    const stats = mockDashboardStats({
      agents: { online: 3, total: 5 },
      campaigns: { running: 2 },
      tasks: { running: 10 },
      cracked: { total: 42 },
    });

    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: stats },
    });

    setAuthenticatedWithProject(1);
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('3 / 5')).toBeDefined();
    });

    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('10')).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();
  });

  it('shows loading placeholders while fetching stats', () => {
    // Use a fetch mock that returns a never-resolving promise to simulate loading
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    } as ReturnType<typeof mockFetch>;

    setAuthenticatedWithProject(1);
    renderWithProviders(<DashboardPage />);

    // All stat cards should show em dash placeholder
    const placeholders = screen.getAllByText('-');
    expect(placeholders.length).toBe(4);
  });

  it('displays connection indicator', async () => {
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: mockDashboardStats() },
    });

    setAuthenticatedWithProject(1);
    renderWithProviders(<DashboardPage />);

    // Initially WebSocket is connecting, so indicator should show Polling
    // After WS connects, it should show Live
    const ws = wsMock.instances[0];
    if (ws) {
      ws.simulateOpen();

      await waitFor(() => {
        expect(screen.getByText('Live')).toBeDefined();
      });
    }
  });

  describe('card navigation', () => {
    function renderDashboardWithRoutes() {
      const stats = mockDashboardStats({
        agents: { online: 3, total: 5 },
        campaigns: { running: 2 },
        tasks: { running: 10 },
        cracked: { total: 42 },
      });

      fetchMock = mockFetch({
        '/dashboard/stats': { status: 200, body: stats },
      });

      setAuthenticatedWithProject(1);

      return renderWithRouter(
        [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <div>Agents Page</div> },
          { path: '/campaigns', element: <div>Campaigns Page</div> },
          { path: '/results', element: <div>Results Page</div> },
        ],
        { initialRoute: '/' }
      );
    }

    it('navigates to /agents when Agents card is clicked', async () => {
      renderDashboardWithRoutes();

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined();
      });

      const agentsButton = screen.getByText('Agents').closest('button');
      expect(agentsButton).toBeDefined();
      fireEvent.click(agentsButton!);

      expect(screen.getByText('Agents Page')).toBeDefined();
    });

    it('navigates to /campaigns when Campaigns card is clicked', async () => {
      renderDashboardWithRoutes();

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined();
      });

      const campaignsButton = screen.getByText('Campaigns').closest('button');
      expect(campaignsButton).toBeDefined();
      fireEvent.click(campaignsButton!);

      expect(screen.getByText('Campaigns Page')).toBeDefined();
    });

    it('navigates to /campaigns when Tasks card is clicked', async () => {
      renderDashboardWithRoutes();

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined();
      });

      const tasksButton = screen.getByText('Tasks').closest('button');
      expect(tasksButton).toBeDefined();
      fireEvent.click(tasksButton!);

      expect(screen.getByText('Campaigns Page')).toBeDefined();
    });

    it('navigates to /results when Cracked card is clicked', async () => {
      renderDashboardWithRoutes();

      await waitFor(() => {
        expect(screen.getByText('3 / 5')).toBeDefined();
      });

      const crackedButton = screen.getByText('Cracked').closest('button');
      expect(crackedButton).toBeDefined();
      fireEvent.click(crackedButton!);

      expect(screen.getByText('Results Page')).toBeDefined();
    });
  });
});
