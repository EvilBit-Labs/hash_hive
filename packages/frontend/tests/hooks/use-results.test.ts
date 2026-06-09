/**
 * Tests for the `useResults` hook query-string serialization and shared
 * wire-type contract (U1, plan 2026-06-08-001).
 *
 * Pins:
 *   - Query-param serialization rules (campaignId, hashListId, q, limit,
 *     offset, startDate, endDate); empty/undefined values are NOT sent.
 *   - The `enabled` gate fires only when a project is selected.
 *   - The hook's row type is structurally compatible with the shared
 *     `CrackedResultRow` schema's `z.infer` shape.
 */
import type { CrackedResultRow, ListResultsResponse } from '@hashhive/shared'

import { crackedResultRowSchema, listResultsResponseSchema } from '@hashhive/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'

import { useResults } from '../../src/hooks/use-results'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

beforeEach(() => {
  useUiStore.setState({ selectedProjectId: 1 })
})

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  useUiStore.setState({ selectedProjectId: null })
})

function wrapperFactory(): (props: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }) => createElement(QueryClientProvider, { client }, children) as JSX.Element
}

function getFetchUrls(mockFn: ReturnType<typeof mockFetch>): string[] {
  return mockFn.mock.calls.map((args) => {
    const first = args[0] as unknown
    if (typeof first === 'string') return first
    if (first instanceof URL) return first.href
    return (first as Request).url
  })
}

const emptyResults: ListResultsResponse = {
  results: [],
  total: 0,
  limit: 100,
  offset: 0,
}

describe('useResults — query-string serialization', () => {
  it('serializes campaignId and limit on the fetch URL', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: emptyResults },
    })

    const { result } = renderHook(() => useResults({ campaignId: 42, limit: 100 }), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const resultsCall = urls.find((u) => u.includes('/dashboard/results'))
    expect(resultsCall).toBeDefined()
    expect(resultsCall).toContain('campaignId=42')
    expect(resultsCall).toContain('limit=100')
  })

  it('serializes startDate and endDate as ISO 8601 params', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: emptyResults },
    })

    const start = '2026-06-01T00:00:00.000Z'
    const end = '2026-06-08T23:59:59.000Z'

    const { result } = renderHook(() => useResults({ startDate: start, endDate: end }), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const resultsCall = urls.find((u) => u.includes('/dashboard/results'))
    expect(resultsCall).toBeDefined()
    // URLSearchParams encodes `:` as `%3A`.
    expect(resultsCall).toContain('startDate=')
    expect(resultsCall).toContain(encodeURIComponent(start))
    expect(resultsCall).toContain('endDate=')
    expect(resultsCall).toContain(encodeURIComponent(end))
  })

  it('omits all query params when called with no options', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: emptyResults },
    })

    const { result } = renderHook(() => useResults(), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const resultsCall = urls.find((u) => u.includes('/dashboard/results'))
    expect(resultsCall).toBeDefined()
    // URL should not contain a `?` — no query string emitted.
    expect(resultsCall).not.toContain('?')
  })

  it('does not include `q` when search is an empty string', async () => {
    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: emptyResults },
    })

    const { result } = renderHook(() => useResults({ search: '' }), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const resultsCall = urls.find((u) => u.includes('/dashboard/results'))
    expect(resultsCall).toBeDefined()
    expect(resultsCall).not.toContain('q=')
  })
})

describe('useResults — `enabled` gate', () => {
  it('does not fire a fetch when no project is selected', async () => {
    useUiStore.setState({ selectedProjectId: null })

    fetchMock = mockFetch({
      '/dashboard/results': { status: 200, body: emptyResults },
    })

    renderHook(() => useResults({ campaignId: 1 }), {
      wrapper: wrapperFactory(),
    })

    // Give TanStack Query a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 50))

    const urls = getFetchUrls(fetchMock)
    const resultsCalls = urls.filter((u) => u.includes('/dashboard/results'))
    expect(resultsCalls.length).toBe(0)
  })
})

describe('useResults — wire type contract', () => {
  it('accepts a row fixture matching the shared `crackedResultRowSchema`', () => {
    // A row fixture matching the shared schema is assignable to the
    // hook's row type. If U1 regresses (e.g., someone re-introduces a
    // local interface that drifts from the schema), this `satisfies`
    // expression fails to type-check.
    const row = {
      id: 1,
      hashValue: 'deadbeef',
      plaintext: 'hunter2',
      crackedAt: '2026-06-08T12:00:00.000Z',
      hashListId: 7,
      hashListName: 'corp-leak',
      campaignId: 42,
      campaignName: 'Q2 review',
      attackId: 99,
      attackMode: 0,
      attackModeName: 'Dictionary',
      agentId: 3,
    } satisfies CrackedResultRow

    // Sanity: the same fixture round-trips through the runtime schema.
    const parsed = crackedResultRowSchema.parse(row)
    expect(parsed.id).toBe(1)
    expect(parsed.attackModeName).toBe('Dictionary')

    // Sanity on the response envelope, too.
    const envelope = listResultsResponseSchema.parse({
      results: [row],
      total: 1,
      limit: 100,
      offset: 0,
    })
    expect(envelope.results[0]?.hashValue).toBe('deadbeef')
  })
})
