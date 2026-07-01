/**
 * Tests for HashSearchPage (U12).
 *
 * Covers the five observable states:
 *   no-project → select-project prompt
 *   idle        → enter-query prompt (q empty)
 *   results     → hash rows rendered
 *   empty       → no-matches message after a query returns zero rows
 *   error       → inline error banner + Retry button
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { HashSearchPage } from '../../src/pages/hash-search'
import { useUiStore } from '../../src/stores/ui'
import { mockHashSearchResponse } from '../fixtures/api-responses'
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

describe('HashSearchPage — no-project state', () => {
  it('shows the select-project prompt when no project is selected', () => {
    fetchMock = mockFetch({})
    renderWithProviders(<HashSearchPage />)

    expect(screen.getByText('Select a project to search hashes')).toBeDefined()
  })

  it('renders the page heading regardless of project state', () => {
    fetchMock = mockFetch({})
    renderWithProviders(<HashSearchPage />)

    expect(screen.getByRole('heading', { name: 'Hash Search' })).toBeDefined()
  })
})

describe('HashSearchPage — idle state', () => {
  it('shows the idle prompt when a project is selected but no query is entered', () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: mockHashSearchResponse() },
    })
    selectProject()
    renderWithProviders(<HashSearchPage />)

    expect(
      screen.getByText("Enter a hash value to search across this project's lists")
    ).toBeDefined()
  })

  it('renders the search input', () => {
    fetchMock = mockFetch({})
    selectProject()
    renderWithProviders(<HashSearchPage />)

    expect(screen.getByRole('textbox', { name: 'Hash search query' })).toBeDefined()
  })

  it('does not fire a search API call when query is empty', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: mockHashSearchResponse() },
    })
    selectProject()
    renderWithProviders(<HashSearchPage />)

    await new Promise((r) => setTimeout(r, 50))

    const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>
    const searchCalls = calls.filter(([url]) => url.includes('/dashboard/hashes/search'))
    expect(searchCalls.length).toBe(0)
  })
})

describe('HashSearchPage — results state', () => {
  it('displays hash values after typing a query', async () => {
    const searchData = mockHashSearchResponse({
      count: 2,
      results: [
        { hashValue: 'abc123', hashListId: 1, hashListName: 'NTLM Dump', crackedAt: null },
        {
          hashValue: 'def456',
          hashListId: 2,
          hashListName: 'WiFi List',
          crackedAt: '2026-06-30T12:00:00.000Z',
        },
      ],
    })

    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: searchData },
    })

    selectProject()
    renderWithProviders(<HashSearchPage />)

    const input = screen.getByRole('textbox', { name: 'Hash search query' })
    fireEvent.change(input, { target: { value: 'abc' } })

    await waitFor(
      () => {
        expect(screen.getByText('abc123')).toBeDefined()
      },
      { timeout: 1500 }
    )

    expect(screen.getByText('def456')).toBeDefined()
  })
})

describe('HashSearchPage — empty state', () => {
  it('shows the no-matches message when API returns zero results', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': {
        status: 200,
        body: { results: [], total: 0, limit: 50, offset: 0 },
      },
    })

    selectProject()
    renderWithProviders(<HashSearchPage />)

    const input = screen.getByRole('textbox', { name: 'Hash search query' })
    fireEvent.change(input, { target: { value: 'notfound' } })

    await waitFor(
      () => {
        expect(screen.getByText('No matches found for "notfound"')).toBeDefined()
      },
      { timeout: 1500 }
    )
  })
})

describe('HashSearchPage — error state', () => {
  it('shows the error banner and a Retry button on API failure', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 500, body: { error: 'Internal Server Error' } },
    })

    selectProject()
    renderWithProviders(<HashSearchPage />)

    const input = screen.getByRole('textbox', { name: 'Hash search query' })
    fireEvent.change(input, { target: { value: 'errorhash' } })

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeDefined()
      },
      { timeout: 1500 }
    )

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })
})
