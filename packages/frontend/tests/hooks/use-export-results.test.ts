import type { ReactNode } from 'react'

/**
 * Covers AE2 (CSV export as a mutation with loading state).
 *
 * Pins the mutation's contract: serialize filters to URLSearchParams,
 * read `Content-Disposition` for the download filename (RFC 6266
 * double-quoted form), fall back to a client-composed filename when
 * the header is absent, and always release the object URL via the
 * `try/finally` in the hook — never leak a blob.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'

import { useExportResults } from '../../src/hooks/use-export-results'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

// Capture `URL.createObjectURL` / `URL.revokeObjectURL` so we can
// observe lifecycle without leaking blob URLs in happy-dom. Both are
// bound to `URL` to satisfy the unbound-method lint rule — they don't
// touch `this`, but the rule is conservative.
const originalCreate = URL.createObjectURL.bind(URL)
const originalRevoke = URL.revokeObjectURL.bind(URL)

let createObjectUrl: ReturnType<typeof mock>
let revokeObjectUrl: ReturnType<typeof mock>

beforeEach(() => {
  createObjectUrl = mock((_blob: Blob) => 'blob:hashhive/fake-url')
  revokeObjectUrl = mock((_url: string) => {})
  URL.createObjectURL = createObjectUrl as typeof URL.createObjectURL
  URL.revokeObjectURL = revokeObjectUrl as typeof URL.revokeObjectURL
  useUiStore.getState().setSelectedProject(7)
})

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
})

function wrapper(): { wrapper: (props: { children: ReactNode }) => JSX.Element } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client }, children) as JSX.Element,
  }
}

describe('useExportResults', () => {
  it('serializes filters into the export request URL', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results-x.csv"',
        },
      },
    })

    const { result } = renderHook(() => useExportResults(), wrapper())

    result.current.mutate({
      campaignId: 42,
      hashListId: 9,
      search: 'admin',
      startDate: '2026-06-01T00:00:00.000Z',
      endDate: '2026-06-08T23:59:59.000Z',
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const calls = fetchMock.mock.calls
    expect(calls.length).toBe(1)
    const url = String(calls[0]?.[0])
    expect(url).toContain('/api/v1/dashboard/results/export?')
    expect(url).toContain('campaignId=42')
    expect(url).toContain('hashListId=9')
    expect(url).toContain('q=admin')
    expect(url).toContain('startDate=2026-06-01')
    expect(url).toContain('endDate=2026-06-08')

    const init = calls[0]?.[1] as RequestInit | undefined
    expect(init?.credentials).toBe('include')
  })

  it('downloads the blob with the filename from Content-Disposition', async () => {
    const filenameFromHeader = 'results-2026-06-08T14-23-11.csv'
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${filenameFromHeader}"`,
        },
      },
    })

    // Spy on document.createElement('a') so we can assert the anchor's
    // download attribute mirrored the header filename.
    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    const createElementSpy = mock((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        capturedAnchor = el as HTMLAnchorElement
        capturedAnchor.click = mock(() => {})
      }
      return el
    })
    document.createElement = createElementSpy as unknown as typeof document.createElement

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(createObjectUrl).toHaveBeenCalledTimes(1)
      expect(capturedAnchor).not.toBeNull()
      expect(capturedAnchor!.download).toBe(filenameFromHeader)
      expect(capturedAnchor!.href).toContain('blob:hashhive/fake-url')
      expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    } finally {
      document.createElement = originalCreateElement
    }
  })

  it('falls back to results-{projectId}-{ISO}.csv when Content-Disposition is absent', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: { 'Content-Type': 'text/csv' },
      },
    })

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = mock((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        capturedAnchor = el as HTMLAnchorElement
        capturedAnchor.click = mock(() => {})
      }
      return el
    }) as unknown as typeof document.createElement

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(capturedAnchor).not.toBeNull()
      // Selected project id is 7 (set in beforeEach). The timestamp
      // has `:` and `.` replaced with `-` so the filename is valid
      // on Windows / NTFS.
      expect(capturedAnchor!.download).toMatch(
        /^results-7-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.csv$/
      )
    } finally {
      document.createElement = originalCreateElement
    }
  })

  it('uses fallback filename when Content-Disposition has no filename parameter', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment',
        },
      },
    })

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = mock((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        capturedAnchor = el as HTMLAnchorElement
        capturedAnchor.click = mock(() => {})
      }
      return el
    }) as unknown as typeof document.createElement

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(capturedAnchor!.download).toMatch(/^results-7-.*\.csv$/)
    } finally {
      document.createElement = originalCreateElement
    }
  })

  it('marks the mutation as error on 401 and does NOT call createObjectURL', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'auth' } },
      },
    })

    const { result } = renderHook(() => useExportResults(), wrapper())
    result.current.mutate({})

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(revokeObjectUrl).not.toHaveBeenCalled()
  })

  it('serializes scope, variant, and format into the export request URL', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results-x.csv"',
        },
      },
    })

    const { result } = renderHook(() => useExportResults(), wrapper())

    result.current.mutate({
      scope: 'campaign',
      variant: 'plaintext-only',
      format: 'hashcat-potfile',
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('scope=campaign')
    expect(url).toContain('variant=plaintext-only')
    expect(url).toContain('format=hashcat-potfile')
  })

  it('returns skippedCount from the x-export-skipped response header', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results-x.csv"',
          'x-export-skipped': '7',
        },
      },
    })

    const originalCreateElement = document.createElement.bind(document)
    document.createElement = mock((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = mock(() => {})
      return el
    }) as unknown as typeof document.createElement

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data?.skippedCount).toBe(7)
    } finally {
      document.createElement = originalCreateElement
    }
  })

  it('returns skippedCount of 0 when x-export-skipped header is absent', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results-x.csv"',
        },
      },
    })

    const originalCreateElement = document.createElement.bind(document)
    document.createElement = mock((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = mock(() => {})
      return el
    }) as unknown as typeof document.createElement

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data?.skippedCount).toBe(0)
    } finally {
      document.createElement = originalCreateElement
    }
  })

  it('returns skippedCount of 0 when x-export-skipped header is non-numeric', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results-x.csv"',
          'x-export-skipped': 'not-a-number',
        },
      },
    })

    const originalCreateElement = document.createElement.bind(document)
    document.createElement = mock((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = mock(() => {})
      return el
    }) as unknown as typeof document.createElement

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data?.skippedCount).toBe(0)
    } finally {
      document.createElement = originalCreateElement
    }
  })

  it('marks the mutation as error when response.blob() rejects, without leaking an object URL', async () => {
    // Hand-craft a Response whose `.blob()` rejects to simulate a
    // network drop mid-stream. We can't express this with mockFetch's
    // helper, so we install a one-off `globalThis.fetch` here.
    const original = globalThis.fetch
    const failingBlob = mock(() => Promise.reject(new Error('stream truncated')))
    globalThis.fetch = mock(async () => {
      const res = new Response('hash,plaintext\n', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      })
      // Override `.blob()` on this specific Response.
      ;(res as unknown as { blob: typeof failingBlob }).blob = failingBlob
      return res
    }) as unknown as typeof fetch

    try {
      const { result } = renderHook(() => useExportResults(), wrapper())
      result.current.mutate({})

      await waitFor(() => {
        expect(result.current.isError).toBe(true)
      })

      expect(createObjectUrl).not.toHaveBeenCalled()
      expect(revokeObjectUrl).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})
