/**
 * Tests for the `useHashSearch` hook (U12).
 *
 * Pins:
 *   - The `enabled` gate fires only when a project is selected AND q is non-empty.
 *   - Query-param serialization: q, limit, offset appear on the fetch URL.
 *   - Whitespace-only queries are treated as empty (enabled: false).
 *   - The hook's response type is structurally compatible with `HashSearchResponse`.
 */
import type { HashSearchResponse, HashSearchResult } from '@hashhive/shared'

import { hashSearchResponseSchema, hashSearchResultSchema } from '@hashhive/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'

import { useHashSearch } from '../../src/hooks/use-hash-search'
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

const emptySearchResponse: HashSearchResponse = {
  results: [],
  total: 0,
  limit: 50,
  offset: 0,
}

describe('useHashSearch — enabled gate', () => {
  it('fires a fetch when project is selected and q is non-empty', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: emptySearchResponse },
    })

    const { result } = renderHook(() => useHashSearch('deadbeef'), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const searchCall = urls.find((u) => u.includes('/dashboard/hashes/search'))
    expect(searchCall).toBeDefined()
  })

  it('does not fire a fetch when no project is selected', async () => {
    useUiStore.setState({ selectedProjectId: null })

    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: emptySearchResponse },
    })

    renderHook(() => useHashSearch('deadbeef'), {
      wrapper: wrapperFactory(),
    })

    await new Promise((r) => setTimeout(r, 50))

    const urls = getFetchUrls(fetchMock)
    const searchCalls = urls.filter((u) => u.includes('/dashboard/hashes/search'))
    expect(searchCalls.length).toBe(0)
  })

  it('does not fire a fetch when q is empty', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: emptySearchResponse },
    })

    renderHook(() => useHashSearch(''), {
      wrapper: wrapperFactory(),
    })

    await new Promise((r) => setTimeout(r, 50))

    const urls = getFetchUrls(fetchMock)
    const searchCalls = urls.filter((u) => u.includes('/dashboard/hashes/search'))
    expect(searchCalls.length).toBe(0)
  })

  it('does not fire a fetch when q is whitespace only', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: emptySearchResponse },
    })

    renderHook(() => useHashSearch('   '), {
      wrapper: wrapperFactory(),
    })

    await new Promise((r) => setTimeout(r, 50))

    const urls = getFetchUrls(fetchMock)
    const searchCalls = urls.filter((u) => u.includes('/dashboard/hashes/search'))
    expect(searchCalls.length).toBe(0)
  })
})

describe('useHashSearch — query-param serialization', () => {
  it('includes q, limit, and offset on the fetch URL', async () => {
    fetchMock = mockFetch({
      '/dashboard/hashes/search': { status: 200, body: emptySearchResponse },
    })

    const { result } = renderHook(() => useHashSearch('abc123'), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const searchCall = urls.find((u) => u.includes('/dashboard/hashes/search'))
    expect(searchCall).toBeDefined()
    expect(searchCall).toContain('q=abc123')
    expect(searchCall).toContain('limit=')
    expect(searchCall).toContain('offset=0')
  })
})

describe('useHashSearch — wire type contract', () => {
  it('accepts a result fixture matching the shared `hashSearchResultSchema`', () => {
    const result = {
      hashValue: '5f4dcc3b5aa765d61d8327deb882cf99',
      hashListId: 3,
      hashListName: 'corp-leak',
      crackedAt: '2026-06-30T12:00:00.000Z',
    } satisfies HashSearchResult

    const parsed = hashSearchResultSchema.parse(result)
    expect(parsed.hashValue).toBe('5f4dcc3b5aa765d61d8327deb882cf99')
    expect(parsed.crackedAt).toBe('2026-06-30T12:00:00.000Z')

    const envelope = hashSearchResponseSchema.parse({
      results: [result],
      total: 1,
      limit: 50,
      offset: 0,
    })
    expect(envelope.results[0]?.hashListName).toBe('corp-leak')
  })

  it('accepts a result with crackedAt as null (uncracked)', () => {
    const result = {
      hashValue: 'aabbccdd',
      hashListId: 1,
      hashListName: 'ntlm-dump',
      crackedAt: null,
    } satisfies HashSearchResult

    const parsed = hashSearchResultSchema.parse(result)
    expect(parsed.crackedAt).toBeNull()
  })
})
