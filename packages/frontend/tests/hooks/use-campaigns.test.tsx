import type { ReactNode } from 'react'

/**
 * Direct mutation tests for useCampaignLifecycle / useCampaignDelete.
 *
 * Pins the mutate-time campaignId contract: each mutate() invocation
 * must POST/DELETE the campaign id passed to it, not a render-time
 * value. A regression that re-binds the id to hook-construction time
 * would silently revert the F1 review fix (Pause from the list page
 * was firing against /campaigns/0/lifecycle).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { useCampaignDelete, useCampaignLifecycle } from '../../src/hooks/use-campaigns'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function wrapper(): { wrapper: (props: { children: ReactNode }) => JSX.Element } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }
}

function getFetchUrls(mockFn: ReturnType<typeof mockFetch>): string[] {
  return mockFn.mock.calls.map((args) => {
    const first = args[0] as unknown
    return typeof first === 'string'
      ? first
      : first instanceof URL
        ? first.href
        : (first as Request).url
  })
}

describe('useCampaignLifecycle', () => {
  it('POSTs to /campaigns/:id/lifecycle using the id passed at mutate-time', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/42/lifecycle': {
        POST: { status: 200, body: { campaign: { id: 42, status: 'running' } } },
      },
    })

    const { result } = renderHook(() => useCampaignLifecycle(), wrapper())

    result.current.mutate({ campaignId: 42, action: 'start' })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    expect(urls.some((u) => u.includes('/campaigns/42/lifecycle'))).toBe(true)
    expect(urls.some((u) => u.includes('/campaigns/0/lifecycle'))).toBe(false)
  })

  it('targets the correct id on each mutate when called twice with different ids', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/10/lifecycle': {
        POST: { status: 200, body: { campaign: { id: 10, status: 'running' } } },
      },
      '/dashboard/campaigns/20/lifecycle': {
        POST: { status: 200, body: { campaign: { id: 20, status: 'paused' } } },
      },
    })

    const { result } = renderHook(() => useCampaignLifecycle(), wrapper())

    result.current.mutate({ campaignId: 10, action: 'start' })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    result.current.mutate({ campaignId: 20, action: 'pause' })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    expect(urls.some((u) => u.includes('/campaigns/10/lifecycle'))).toBe(true)
    expect(urls.some((u) => u.includes('/campaigns/20/lifecycle'))).toBe(true)
  })

  it('sends the action in the request body', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/5/lifecycle': {
        POST: { status: 200, body: { campaign: { id: 5, status: 'paused' } } },
      },
    })

    const { result } = renderHook(() => useCampaignLifecycle(), wrapper())

    result.current.mutate({ campaignId: 5, action: 'stop' })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const lifecycleCall = fetchMock.mock.calls.find((args) => {
      const url = typeof args[0] === 'string' ? args[0] : ''
      return url.includes('/campaigns/5/lifecycle')
    })
    const init = lifecycleCall?.[1] as RequestInit | undefined
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeDefined()
    if (typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body)
      expect(parsed.action).toBe('stop')
    }
  })
})

describe('useCampaignDelete', () => {
  it('DELETEs /campaigns/:id using the id passed at mutate-time', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/99': {
        DELETE: { status: 200, body: { deleted: true, id: 99 } },
      },
    })

    const { result } = renderHook(() => useCampaignDelete(), wrapper())

    result.current.mutate({ campaignId: 99 })
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const urls = getFetchUrls(fetchMock)
    expect(urls.some((u) => u.includes('/campaigns/99'))).toBe(true)
  })

  it('throws when the server returns deleted: false (contract regression guard)', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/7': {
        DELETE: { status: 200, body: { deleted: false, id: 7 } },
      },
    })

    const { result } = renderHook(() => useCampaignDelete(), wrapper())

    result.current.mutate({ campaignId: 7 })
    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect(result.current.error?.message).toContain('deleted: true')
  })

  it('surfaces 409 NOT_DRAFT errors instead of treating them as success', async () => {
    fetchMock = mockFetch({
      '/dashboard/campaigns/11': {
        DELETE: {
          status: 409,
          body: { error: { code: 'NOT_DRAFT', message: 'running' } },
        },
      },
    })

    const { result } = renderHook(() => useCampaignDelete(), wrapper())

    result.current.mutate({ campaignId: 11 })
    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
  })
})
