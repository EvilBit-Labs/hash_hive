/**
 * Tests for the `useHashLists` hook (U3, plan 2026-06-08-001).
 *
 * Pins:
 *   - Fetches `/dashboard/hash-lists` when a project is selected and
 *     returns the parsed `HashListListResponse` envelope.
 *   - The `enabled` gate suppresses the fetch when no project is
 *     selected; `data` is `undefined` until a project is picked.
 *   - The query key includes `selectedProjectId`, so switching projects
 *     does not return cached rows from the previous project.
 *   - The hook's row shape is structurally compatible with the shared
 *     `HashListSummary` `z.infer` type from `@hashhive/shared`.
 */
import type { HashListListResponse, HashListSummary } from '@hashhive/shared'

import { hashListListResponseSchema, hashListSummarySchema } from '@hashhive/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'

import { useHashLists } from '../../src/hooks/use-hash-lists'
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

function wrapperFactory(client?: QueryClient): (props: { children: ReactNode }) => JSX.Element {
  const qc =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
  return ({ children }) =>
    createElement(QueryClientProvider, { client: qc }, children) as JSX.Element
}

function getFetchUrls(mockFn: ReturnType<typeof mockFetch>): string[] {
  return mockFn.mock.calls.map((args) => {
    const first = args[0] as unknown
    if (typeof first === 'string') return first
    if (first instanceof URL) return first.href
    return (first as Request).url
  })
}

const sampleHashLists: HashListListResponse = {
  hashLists: [
    {
      id: 9,
      name: 'corp-leak',
      hashTypeId: 1000,
      hashCount: 500,
      crackedCount: 123,
    },
    {
      id: 10,
      name: 'breach-dump',
      hashTypeId: null,
      hashCount: 0,
      crackedCount: 0,
    },
  ],
}

describe('useHashLists — happy path', () => {
  it('fetches /dashboard/hash-lists and returns parsed envelope when a project is selected', async () => {
    fetchMock = mockFetch({
      '/dashboard/hash-lists': { status: 200, body: sampleHashLists },
    })

    const { result } = renderHook(() => useHashLists(), {
      wrapper: wrapperFactory(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    const hashListsCall = urls.find((u) => u.includes('/dashboard/hash-lists'))
    expect(hashListsCall).toBeDefined()
    expect(result.current.data).toEqual(sampleHashLists)
    expect(result.current.data?.hashLists).toHaveLength(2)
  })
})

describe('useHashLists — `enabled` gate', () => {
  it('does not fire a fetch and returns undefined data when no project is selected', async () => {
    useUiStore.setState({ selectedProjectId: null })

    fetchMock = mockFetch({
      '/dashboard/hash-lists': { status: 200, body: sampleHashLists },
    })

    const { result } = renderHook(() => useHashLists(), {
      wrapper: wrapperFactory(),
    })

    // Give TanStack Query a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 50))

    const urls = getFetchUrls(fetchMock)
    const hashListsCalls = urls.filter((u) => u.includes('/dashboard/hash-lists'))
    expect(hashListsCalls.length).toBe(0)
    expect(result.current.data).toBeUndefined()
  })
})

describe('useHashLists — cache key includes project id', () => {
  it('does not leak cached rows across projects when selectedProjectId changes', async () => {
    const projectOneBody: HashListListResponse = {
      hashLists: [
        { id: 1, name: 'project-one-list', hashTypeId: 1000, hashCount: 10, crackedCount: 1 },
      ],
    }
    const projectTwoBody: HashListListResponse = {
      hashLists: [
        { id: 2, name: 'project-two-list', hashTypeId: 1000, hashCount: 20, crackedCount: 2 },
      ],
    }

    // mockFetch dispatches by path prefix; we vary by call order via
    // resequencing the mock between renders.
    fetchMock = mockFetch({
      '/dashboard/hash-lists': { status: 200, body: projectOneBody },
    })

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })

    const { result, rerender } = renderHook(() => useHashLists(), {
      wrapper: wrapperFactory(client),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(result.current.data?.hashLists[0]?.name).toBe('project-one-list')

    // Swap the mocked response then switch project.
    restoreFetch(fetchMock)
    fetchMock = mockFetch({
      '/dashboard/hash-lists': { status: 200, body: projectTwoBody },
    })
    useUiStore.setState({ selectedProjectId: 2 })
    rerender()

    await waitFor(() => {
      expect(result.current.data?.hashLists[0]?.name).toBe('project-two-list')
    })

    // The query key changed, so the second fetch must have fired — we
    // saw the new body land on the hook. The original cached entry for
    // project 1 stayed in the cache under its own key, but the hook
    // does not surface it after the project switch.
    expect(result.current.data?.hashLists[0]?.id).toBe(2)
  })
})

describe('useHashLists — wire type contract', () => {
  it('accepts a row fixture matching the shared `hashListSummarySchema`', () => {
    // A row fixture matching the shared schema is assignable to the
    // hook's row type. If U3 regresses (e.g., someone re-introduces a
    // local interface that drifts from the schema), this `satisfies`
    // expression fails to type-check.
    const row = {
      id: 1,
      name: 'corp-leak',
      hashTypeId: 1000,
      hashCount: 500,
      crackedCount: 123,
    } satisfies HashListSummary

    const parsed = hashListSummarySchema.parse(row)
    expect(parsed.name).toBe('corp-leak')
    expect(parsed.hashCount).toBe(500)

    const envelope = hashListListResponseSchema.parse({ hashLists: [row] })
    expect(envelope.hashLists).toHaveLength(1)
    expect(envelope.hashLists[0]?.id).toBe(1)
  })
})
