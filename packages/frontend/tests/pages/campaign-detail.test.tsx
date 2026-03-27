import { afterEach, describe, expect, it } from 'bun:test';
import { CampaignDetailPage } from '../../src/pages/campaign-detail';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { mockCampaignDetailResponse } from '../fixtures/api-responses';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId });
}

function setAuthUser(roles: string[] = ['admin'], projectId = 1) {
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'test@test.com',
      name: 'Test User',
      projects: [{ projectId, projectName: 'Test Project', roles }],
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe('CampaignDetailPage', () => {
  it('shows loading state while fetching', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    fetchMock = {
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    } as ReturnType<typeof mockFetch>;

    selectProject();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    expect(screen.getByText('Loading campaign\...')).toBeDefined();
  });

  it('shows error when API returns 404', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/99': { status: 404, body: { error: { message: 'Not found' } } },
    });

    selectProject();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/99',
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
  });

  it('renders campaign details when data is available', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { id: 1, name: 'NTLM Campaign', status: 'draft', priority: 10 },
      attacks: [{ id: 1, mode: 0, status: 'pending', wordlistId: 1 }],
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined();
    });

    expect(screen.getByText('draft')).toBeDefined();
    expect(screen.getByText('10')).toBeDefined();
    // "Attacks" appears in both the stat card and section heading
    expect(screen.getAllByText('Attacks').length).toBeGreaterThanOrEqual(1);
  });

  it('renders Start button for draft campaigns', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { status: 'draft' },
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    setAuthUser();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    await waitFor(() => {
      expect(screen.getByText('Start')).toBeDefined();
    });
  });

  it('renders Pause, Stop, Cancel buttons for running campaigns', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { status: 'running', startedAt: new Date().toISOString() },
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    setAuthUser();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    await waitFor(() => {
      expect(screen.getByText('Pause')).toBeDefined();
    });

    expect(screen.getByText('Stop')).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
  });

  it('renders Resume, Stop, Cancel buttons for paused campaigns', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { status: 'paused' },
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    setAuthUser();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeDefined();
    });

    expect(screen.getByText('Stop')).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
  });

  it('calls lifecycle mutation when clicking a lifecycle button', async () => {
    const data = mockCampaignDetailResponse({
      campaign: { status: 'draft' },
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns/1/lifecycle': {
        POST: { status: 200, body: { campaign: { ...data.campaign, status: 'running' } } },
      },
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    setAuthUser();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    await waitFor(() => {
      expect(screen.getByText('Start')).toBeDefined();
    });

    const startButton = screen.getByText('Start');
    fireEvent.click(startButton);

    // Verify the lifecycle endpoint was called
    await waitFor(() => {
      const calls = (fetchMock as ReturnType<typeof mockFetch>).mock.calls;
      const lifecycleCalls = calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/lifecycle')
      );
      expect(lifecycleCalls.length).toBeGreaterThan(0);
    });
  });

  it('renders Back to campaigns link', async () => {
    const data = mockCampaignDetailResponse();

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    renderWithRouter(
      [
        { path: '/campaigns/:id', element: <CampaignDetailPage /> },
        { path: '/campaigns', element: <div>Campaigns List</div> },
      ],
      { initialRoute: '/campaigns/1' }
    );

    await waitFor(() => {
      expect(screen.getByText('NTLM Campaign')).toBeDefined();
    });

    const backLink = screen.getByText('Back to campaigns');
    expect(backLink.closest('a')?.getAttribute('href')).toBe('/campaigns');
  });

  it('renders attacks table with details', async () => {
    const data = mockCampaignDetailResponse({
      attacks: [
        { id: 1, mode: 0, status: 'pending', wordlistId: 5, dependencies: [2, 3] },
        { id: 2, mode: 3, status: 'running', wordlistId: null },
      ],
    });

    fetchMock = mockFetch({
      '/dashboard/campaigns/1': { status: 200, body: data },
    });

    selectProject();
    renderWithRouter([{ path: '/campaigns/:id', element: <CampaignDetailPage /> }], {
      initialRoute: '/campaigns/1',
    });

    await waitFor(() => {
      expect(screen.getByText('pending')).toBeDefined();
    });

    expect(screen.getByText('running')).toBeDefined();
    expect(screen.getByText('#5')).toBeDefined();
    expect(screen.getByText('2, 3')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined();
  });
});
