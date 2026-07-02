/**
 * Tests for HashSearchTable (U12).
 *
 * Covers the three inner states the component manages:
 *   loading  → skeleton rows visible
 *   empty    → "No matches found for {query}" message
 *   results  → crack-state styling (Cracked / Uncracked) and data display
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { HashSearchTable } from '../../src/components/features/results/hash-search-table'
import { mockHashSearchResponse } from '../fixtures/api-responses'
import { cleanupAll, renderWithMotion, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('HashSearchTable — loading state', () => {
  it('renders skeleton rows while loading', () => {
    renderWithMotion(<HashSearchTable rows={[]} isLoading={true} query="deadbeef" />)
    const status = screen.getByRole('status')
    expect(status).toBeDefined()
  })

  it('does not render the table while loading', () => {
    renderWithMotion(<HashSearchTable rows={[]} isLoading={true} query="deadbeef" />)
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('HashSearchTable — empty state', () => {
  it('shows the no-matches message when results are empty', () => {
    renderWithMotion(<HashSearchTable rows={[]} isLoading={false} query="notfound" />)
    expect(screen.getByText('No matches found for "notfound"')).toBeDefined()
  })
})

describe('HashSearchTable — results state', () => {
  it('renders hash values and hash list names', () => {
    const { results } = mockHashSearchResponse({
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

    renderWithMotion(<HashSearchTable rows={results} isLoading={false} query="abc" />)

    expect(screen.getByText('abc123')).toBeDefined()
    expect(screen.getByText('NTLM Dump')).toBeDefined()
    expect(screen.getByText('def456')).toBeDefined()
    expect(screen.getByText('WiFi List')).toBeDefined()
  })

  it('shows "Cracked" status for rows with crackedAt set', () => {
    const { results } = mockHashSearchResponse({
      count: 1,
      results: [
        {
          hashValue: 'cracked1',
          hashListId: 1,
          hashListName: 'Test List',
          crackedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
    })

    renderWithMotion(<HashSearchTable rows={results} isLoading={false} query="cracked1" />)

    expect(screen.getByText('Cracked')).toBeDefined()
  })

  it('shows "Uncracked" status for rows with crackedAt null', () => {
    const { results } = mockHashSearchResponse({
      count: 1,
      results: [
        {
          hashValue: 'notcracked',
          hashListId: 1,
          hashListName: 'Test List',
          crackedAt: null,
        },
      ],
    })

    renderWithMotion(<HashSearchTable rows={results} isLoading={false} query="notcracked" />)

    expect(screen.getByText('Uncracked')).toBeDefined()
  })

  it('renders a dash for crackedAt when null', () => {
    const { results } = mockHashSearchResponse({
      count: 1,
      results: [{ hashValue: 'h1', hashListId: 1, hashListName: 'L1', crackedAt: null }],
    })

    renderWithMotion(<HashSearchTable rows={results} isLoading={false} query="h1" />)

    expect(screen.getByText('-')).toBeDefined()
  })

  it('renders column headers', () => {
    const { results } = mockHashSearchResponse({ count: 1 })

    renderWithMotion(<HashSearchTable rows={results} isLoading={false} query="test" />)

    expect(screen.getByText('Hash Value')).toBeDefined()
    expect(screen.getByText('Hash List')).toBeDefined()
    expect(screen.getByText('Status')).toBeDefined()
    expect(screen.getByText('Cracked At')).toBeDefined()
  })
})
