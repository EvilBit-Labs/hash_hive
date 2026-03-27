import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { useDashboardStats } from '../../src/hooks/use-dashboard';
import { useUiStore } from '../../src/stores/ui';
import { mockDashboardStats } from '../fixtures/api-responses';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { installMockWebSocket } from '../mocks/websocket';
import { cleanupAll, createTestQueryClient, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;
let wsMock: ReturnType<typeof installMockWebSocket>;

function DashboardStatsTestComponent() {
  const { data, isLoading, error } = useDashboardStats();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="data">{data ? JSON.stringify(data) : 'no-data'}</span>
      <span data-testid="error">{error ? String(error) : 'no-error'}</span>
    </div>
  );
}

function renderDashboardStatsHook() {
  const qc = createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DashboardStatsTestComponent />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  // useEvents in dashboard needs WebSocket - install mock to prevent errors
  wsMock = installMockWebSocket();
});

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
  wsMock.restore();
});

describe('useDashboardStats', () => {
  it('fetches stats when project selected', async () => {
    const stats = mockDashboardStats({ agents: { online: 3, total: 5 } });
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: stats },
    });

    useUiStore.setState({ selectedProjectId: 1 });
    renderDashboardStatsHook();

    await waitFor(() => {
      const dataEl = screen.getByTestId('data');
      expect(dataEl.textContent).not.toBe('no-data');
    });

    const data = JSON.parse(screen.getByTestId('data').textContent!);
    expect(data.agents.online).toBe(3);
    expect(data.agents.total).toBe(5);
  });

  it('does not fetch when no project selected', async () => {
    fetchMock = mockFetch({
      '/dashboard/stats': { status: 200, body: mockDashboardStats() },
    });

    useUiStore.setState({ selectedProjectId: null });
    renderDashboardStatsHook();

    // Give time for any potential fetch
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.getByTestId('data').textContent).toBe('no-data');
    // Fetch should not have been called for stats
    const statsCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/dashboard/stats')
    );
    expect(statsCalls.length).toBe(0);
  });
});
