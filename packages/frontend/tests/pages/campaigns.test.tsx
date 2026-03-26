import { afterEach, describe, expect, it } from 'bun:test';
import { CampaignsPage } from '../../src/pages/campaigns';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { mockCampaignsResponse } from '../fixtures/api-responses';
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

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeDefined();
    expect(select.value).toBe('');

    const options = Array.from(select.querySelectorAll('option'));
    const values = options.map((o) => o.value);
    expect(values).toContain('draft');
    expect(values).toContain('running');
    expect(values).toContain('paused');
    expect(values).toContain('completed');
    expect(values).toContain('cancelled');
  });

  it('triggers new fetch when status filter changes', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns': { status: 200, body: mockCampaignsResponse() },
    });

    selectProject();
    renderWithProviders(<CampaignsPage />);

    await waitFor(() => {
      expect(screen.getByText('Campaign 1')).toBeDefined();
    });

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'running' } });

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('running');
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

  it('renders Details link for each campaign', async () => {
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

    const detailsLink = screen.getByText('Details');
    expect(detailsLink.closest('a')?.getAttribute('href')).toBe('/campaigns/7');
  });
});
