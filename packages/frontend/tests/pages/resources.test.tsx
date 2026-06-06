import { afterEach, describe, expect, it } from 'bun:test'

import { ResourcesPage } from '../../src/pages/resources'
import { useUiStore } from '../../src/stores/ui'
import { mockHashListsResponse, mockResourcesResponse } from '../fixtures/api-responses'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId })
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
  })
}

describe('ResourcesPage', () => {
  it('shows empty state when no project selected', () => {
    fetchMock = mockFetch()
    renderWithProviders(<ResourcesPage />)

    expect(screen.getByText('Select a project to view resources.')).toBeDefined()
  })

  it('renders tab navigation when project selected', async () => {
    fetchMock = setupResourceMocks()
    selectProject()
    renderWithProviders(<ResourcesPage />)

    expect(screen.getByRole('tab', { name: 'Hash Lists' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Wordlists' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Rulelists' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Masklists' })).toBeDefined()
    // Hash detection lives in a page-level button (issue #163), not a tab.
    expect(screen.queryByRole('tab', { name: 'Hash Detect' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Detect Hash Type' })).toBeDefined()
  })

  it('renders hash lists table on default tab', async () => {
    const hashLists = mockHashListsResponse({
      hashLists: [{ id: 1, name: 'NTLM Hashes', hashCount: 500, crackedCount: 42 }],
    })

    fetchMock = setupResourceMocks({
      '/dashboard/resources/hash-lists': { status: 200, body: hashLists },
    })

    selectProject()
    renderWithProviders(<ResourcesPage />)

    await waitFor(() => {
      expect(screen.getByText('NTLM Hashes')).toBeDefined()
    })

    expect(screen.getByText('500')).toBeDefined()
    expect(screen.getByText('42')).toBeDefined()
  })

  it('switches to wordlists tab when clicked', async () => {
    fetchMock = setupResourceMocks()
    selectProject()
    renderWithProviders(<ResourcesPage />)

    const wordlistsTab = screen.getByText('Wordlists')
    fireEvent.click(wordlistsTab)

    await waitFor(() => {
      expect(screen.getByText('rockyou.txt')).toBeDefined()
    })
  })

  it('switches to rulelists tab when clicked', async () => {
    fetchMock = setupResourceMocks()
    selectProject()
    renderWithProviders(<ResourcesPage />)

    const rulelistsTab = screen.getByText('Rulelists')
    fireEvent.click(rulelistsTab)

    await waitFor(() => {
      expect(screen.getByText('best64.rule')).toBeDefined()
    })
  })

  it('switches to masklists tab when clicked', async () => {
    fetchMock = setupResourceMocks()
    selectProject()
    renderWithProviders(<ResourcesPage />)

    const masklistsTab = screen.getByText('Masklists')
    fireEvent.click(masklistsTab)

    await waitFor(() => {
      expect(screen.getByText('?d?d?d?d')).toBeDefined()
    })
  })

  it('opens the hash type detect modal from the page-level button', async () => {
    fetchMock = setupResourceMocks()
    selectProject()
    renderWithProviders(<ResourcesPage />)

    const detectButton = screen.getByRole('button', { name: 'Detect Hash Type' })
    fireEvent.click(detectButton)

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Detect Hash Type' })).toBeDefined()
    })
    expect(screen.getByLabelText('Sample hashes')).toBeDefined()
  })

  it('disables Detect until 5–10 samples are present', async () => {
    fetchMock = setupResourceMocks()
    selectProject()
    renderWithProviders(<ResourcesPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Detect Hash Type' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Sample hashes')).toBeDefined()
    })

    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement
    expect(detect.disabled).toBe(true)

    fireEvent.change(textarea, { target: { value: 'h1\nh2\nh3\nh4\nh5' } })
    expect(detect.disabled).toBe(false)

    fireEvent.change(textarea, {
      target: { value: 'h1\nh2\nh3\nh4\nh5\nh6\nh7\nh8\nh9\nh10\nh11' },
    })
    expect(detect.disabled).toBe(true)
  })
})
