import { mock } from 'bun:test'

interface MockResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

interface RouteConfig {
  [path: string]: MockResponse | Record<HttpMethod, MockResponse>
}

/**
 * Replaces global `fetch` with a mock that returns pre-configured responses.
 *
 * Routes can be method-specific or apply to all methods:
 *
 * ```ts
 * const fetchMock = mockFetch({
 *   '/api/v1/dashboard/auth/login': { status: 200, body: { user: {...} } },
 *   '/api/v1/dashboard/stats': { GET: { status: 200, body: stats } },
 * });
 * ```
 *
 * Returns the mock function for assertions (call count, args, etc.).
 */
export function mockFetch(routes: RouteConfig = {}) {
  const originalFetch = globalThis.fetch
  const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = ((init?.method as string) ?? 'GET').toUpperCase() as HttpMethod

    // Match against registered routes (path portion only)
    for (const [path, config] of Object.entries(routes)) {
      if (!url.includes(path)) continue

      let response: MockResponse
      if ('status' in config || 'body' in config) {
        response = config as MockResponse
      } else {
        const methodConfig = (config as Record<HttpMethod, MockResponse>)[method]
        if (!methodConfig) continue
        response = methodConfig
      }

      const status = response.status ?? 200
      const body = response.body !== undefined ? JSON.stringify(response.body) : ''
      const headers = new Headers({
        'Content-Type': 'application/json',
        ...(body === '' ? { 'content-length': '0' } : {}),
        ...response.headers,
      })

      return Promise.resolve(
        new Response(body || null, { status, headers, statusText: status === 200 ? 'OK' : 'Error' })
      )
    }

    // Unmatched routes return 404
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  globalThis.fetch = fetchMock as unknown as typeof fetch

  // Attach restore helper
  ;(fetchMock as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = originalFetch
  }

  return fetchMock as ReturnType<typeof mock>
}

/**
 * Restores a mock fetch created by `mockFetch()`.
 */
export function restoreFetch(fetchMock: ReturnType<typeof mockFetch>) {
  fetchMock.restore()
}
