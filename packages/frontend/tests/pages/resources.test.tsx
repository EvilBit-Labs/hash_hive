import { afterEach, describe, expect, it } from 'bun:test';
import { ResourcesPage } from '../../src/pages/resources';
import { useUiStore } from '../../src/stores/ui';
import {
  mockHashListsResponse,
  mockHashTypeGuessResponse,
  mockResourcesResponse,
} from '../fixtures/api-responses';
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

function setupResourceMocks(overrides: Record<string, { status?: number; body?: unknown }> = {}) {
  return mockFetch({
    '/dashboard/resources/hash-lists': {
      status: 200,
      body: mockHashListsResponse(),
      ...overrides['/dashboard/resources/hash-lists'],
    },
    '/dashboard/resources/wordlists': {
      status: 200,
      body: {
        wordlists: mockResourcesResponse({ resources: [{ name: 'rockyou.txt' }] }).resources,
      },
      ...overrides['/dashboard/resources/wordlists'],
    },
    '/dashboard/resources/rulelists': {
      status: 200,
      body: {
        rulelists: mockResourcesResponse({ resources: [{ name: 'best64.rule' }] }).resources,
      },
      ...overrides['/dashboard/resources/rulelists'],
    },
    '/dashboard/resources/masklists': {
      status: 200,
      body: { masklists: mockResourcesResponse({ resources: [{ name: '?d?d?d?d' }] }).resources },
      ...overrides['/dashboard/resources/masklists'],
    },
    ...overrides,
  });
}

describe('ResourcesPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch();
    renderWithProviders(<ResourcesPage />);

    expect(screen.getByText('Select a project to view resources.')).toBeDefined();
  });

  it('renders tab navigation when project selected', async () => {
    fetchMock = setupResourceMocks();
    selectProject();
    renderWithProviders(<ResourcesPage />);

    expect(screen.getByText('Hash Lists')).toBeDefined();
    expect(screen.getByText('Wordlists')).toBeDefined();
    expect(screen.getByText('Rulelists')).toBeDefined();
    expect(screen.getByText('Masklists')).toBeDefined();
    expect(screen.getByText('Hash Detect')).toBeDefined();
  });

  it('renders hash lists table on default tab', async () => {
    const hashLists = mockHashListsResponse({
      hashLists: [{ id: 1, name: 'NTLM Hashes', hashCount: 500, crackedCount: 42 }],
    });

    fetchMock = setupResourceMocks({
      '/dashboard/resources/hash-lists': { status: 200, body: hashLists },
    });

    selectProject();
    renderWithProviders(<ResourcesPage />);

    await waitFor(() => {
      expect(screen.getByText('NTLM Hashes')).toBeDefined();
    });

    expect(screen.getByText('500')).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();
  });

  it('switches to wordlists tab when clicked', async () => {
    fetchMock = setupResourceMocks();
    selectProject();
    renderWithProviders(<ResourcesPage />);

    const wordlistsTab = screen.getByText('Wordlists');
    fireEvent.click(wordlistsTab);

    await waitFor(() => {
      expect(screen.getByText('rockyou.txt')).toBeDefined();
    });
  });

  it('switches to rulelists tab when clicked', async () => {
    fetchMock = setupResourceMocks();
    selectProject();
    renderWithProviders(<ResourcesPage />);

    const rulelistsTab = screen.getByText('Rulelists');
    fireEvent.click(rulelistsTab);

    await waitFor(() => {
      expect(screen.getByText('best64.rule')).toBeDefined();
    });
  });

  it('switches to masklists tab when clicked', async () => {
    fetchMock = setupResourceMocks();
    selectProject();
    renderWithProviders(<ResourcesPage />);

    const masklistsTab = screen.getByText('Masklists');
    fireEvent.click(masklistsTab);

    await waitFor(() => {
      expect(screen.getByText('?d?d?d?d')).toBeDefined();
    });
  });

  it('renders hash detect tab with input and button', async () => {
    fetchMock = setupResourceMocks();
    selectProject();
    renderWithProviders(<ResourcesPage />);

    const hashDetectTab = screen.getByText('Hash Detect');
    fireEvent.click(hashDetectTab);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Paste a hash value\...')).toBeDefined();
    });

    expect(screen.getByText('Detect Type')).toBeDefined();
  });

  it('calls guess hash type mutation and displays results', async () => {
    const guessResponse = mockHashTypeGuessResponse({
      candidates: [
        { name: 'MD5', hashcatMode: 0, category: 'Raw Hash', confidence: 0.95 },
        { name: 'NTLM', hashcatMode: 1000, category: 'OS', confidence: 0.75 },
      ],
      identified: true,
    });

    fetchMock = setupResourceMocks({
      '/dashboard/hashes/guess-type': {
        status: 200,
        body: guessResponse,
      },
    });

    selectProject();
    renderWithProviders(<ResourcesPage />);

    const hashDetectTab = screen.getByText('Hash Detect');
    fireEvent.click(hashDetectTab);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Paste a hash value\...')).toBeDefined();
    });

    const input = screen.getByPlaceholderText('Paste a hash value\...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5f4dcc3b5aa765d61d8327deb882cf99' } });

    const detectButton = screen.getByText('Detect Type');
    fireEvent.click(detectButton);

    await waitFor(() => {
      expect(screen.getByText('MD5')).toBeDefined();
    });

    expect(screen.getByText('NTLM')).toBeDefined();
    expect(screen.getByText('95%')).toBeDefined();
    expect(screen.getByText('75%')).toBeDefined();
    expect(screen.getByText(/Identified/)).toBeDefined();
  });
});
