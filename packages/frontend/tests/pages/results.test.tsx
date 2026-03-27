import { afterEach, describe, expect, it } from 'bun:test';
import { ResultsPage } from '../../src/pages/results';
import { useUiStore } from '../../src/stores/ui';
import { mockResultsResponse } from '../fixtures/api-responses';
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

describe('ResultsPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch();
    renderWithProviders(<ResultsPage />);

    expect(screen.getByText('Select a project to view results.')).toBeDefined();
  });

  it('renders results table when project selected and results returned', async () => {
    const data = mockResultsResponse({
      count: 2,
      results: [
        {
          id: 1,
          hashValue: 'abc123def456',
          plaintext: 'password1',
          campaignName: 'NTLM Campaign',
          hashListName: 'Main List',
        },
        {
          id: 2,
          hashValue: 'xyz789uvw012',
          plaintext: 'secret42',
          campaignName: 'WPA Campaign',
          hashListName: 'WiFi List',
        },
      ],
      total: 2,
    });

    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText('abc123def456')).toBeDefined();
    });

    expect(screen.getByText('password1')).toBeDefined();
    expect(screen.getByText('NTLM Campaign')).toBeDefined();
    expect(screen.getByText('xyz789uvw012')).toBeDefined();
    expect(screen.getByText('secret42')).toBeDefined();
  });

  it('shows no results message when API returns empty list', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': {
        status: 200,
        body: { results: [], total: 0, limit: 50, offset: 0 },
      },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText('No cracked results found.')).toBeDefined();
    });
  });

  it('renders search input', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: mockResultsResponse() },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    const searchInput = screen.getByPlaceholderText('Search hashes or plaintexts\...');
    expect(searchInput).toBeDefined();
  });

  it('updates search value on input change and triggers fetch with query params', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: mockResultsResponse() },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    // Wait for initial load so Export CSV is visible
    await waitFor(() => {
      expect(screen.getByText('Export CSV')).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText(
      'Search hashes or plaintexts\...'
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'password' } });

    expect(searchInput.value).toBe('password');

    // Verify fetch was called with q=password and offset=0
    await waitFor(() => {
      const calls = (fetchMock as ReturnType<typeof mockFetch>).mock.calls as Array<
        [string, ...unknown[]]
      >;
      const searchCall = calls.find(
        ([url]) => typeof url === 'string' && url.includes('q=password') && url.includes('offset=0')
      );
      expect(searchCall).toBeDefined();
    });

    // Export CSV link href should include the q parameter
    const exportLink = screen.getByText('Export CSV');
    expect(exportLink.getAttribute('href')).toContain('q=password');
  });

  it('renders Export CSV link', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: mockResultsResponse() },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText('Export CSV')).toBeDefined();
    });

    const exportLink = screen.getByText('Export CSV');
    expect(exportLink.getAttribute('href')).toBe('/api/v1/dashboard/results/export');
  });

  it('renders pagination controls with correct showing text', async () => {
    const data = mockResultsResponse({ count: 3, total: 100 });

    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText(/1.*of.*100/)).toBeDefined();
    });

    expect(screen.getByText('Next')).toBeDefined();
    expect(screen.getByText('Previous')).toBeDefined();
  });

  it('disables Previous button on first page', async () => {
    const data = mockResultsResponse({ count: 3, total: 100 });

    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText('Previous')).toBeDefined();
    });

    const prevButton = screen.getByText('Previous') as HTMLButtonElement;
    expect(prevButton.disabled).toBe(true);
  });

  it('enables Next button when more pages available', async () => {
    const data = mockResultsResponse({ count: 3, total: 100 });

    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText('Next')).toBeDefined();
    });

    const nextButton = screen.getByText('Next') as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);
  });

  it('clicking Next increments offset', async () => {
    const data = mockResultsResponse({ count: 3, total: 100 });

    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: data },
    });

    selectProject();
    renderWithProviders(<ResultsPage />);

    await waitFor(() => {
      expect(screen.getByText('Next')).toBeDefined();
    });

    const nextButton = screen.getByText('Next');
    fireEvent.click(nextButton);

    // After clicking Next, the showing text should update
    await waitFor(() => {
      expect(screen.getByText(/51.*of.*100/)).toBeDefined();
    });

    // Verify fetch was invoked with offset=50
    const calls = (fetchMock as ReturnType<typeof mockFetch>).mock.calls as Array<
      [string, ...unknown[]]
    >;
    const paginatedCall = calls.find(
      ([url]) => typeof url === 'string' && url.includes('offset=50')
    );
    expect(paginatedCall).toBeDefined();
  });
});
