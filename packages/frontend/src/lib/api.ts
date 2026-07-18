import { useAuthStore } from '../stores/auth'

const API_BASE = '/api/v1'
const DEFAULT_TIMEOUT_MS = 30_000

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Compose the caller's signal with a 30s timeout so no request can hang
  // forever on a slow backend. The sequential attack-creation loop in the
  // campaign wizard would otherwise hold N connections open indefinitely.
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal

  let res: Response
  try {
    // Normalize headers via Headers() so callers passing HeadersInit as a
    // string[][] or Headers instance merge into a flat object rather than
    // landing as numeric indices from an array spread.
    //
    // Pre-#159 this also injected X-Project-Id from useUiStore.
    // The dashboard backend now derives scope exclusively from the
    // server-managed BetterAuth session (issue #159 U4), so the
    // header is dead weight on dashboard requests.
    const mergedHeaders = new Headers({
      'Content-Type': 'application/json',
    })
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        mergedHeaders.set(key, value)
      })
    }
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal,
      credentials: 'include',
      headers: mergedHeaders,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(408, 'REQUEST_TIMEOUT', 'Request timed out')
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, 'REQUEST_ABORTED', 'Request aborted')
    }
    throw err
  }

  if (!res.ok) {
    if (res.status === 401) {
      // Session expired -- clear auth state and redirect to login.
      // `useAuthStore` is a static import; the auth<->api cycle is eval-safe
      // because both modules reference each other only inside function bodies
      // at runtime, never at module-evaluation time.
      useAuthStore.getState().clearAuth()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
      throw new ApiError(401, 'AUTH_SESSION_EXPIRED', 'Session expired')
    }

    const body = await res.json().catch(() => ({}))
    const error = body.error ?? {}
    throw new ApiError(res.status, error.code ?? 'UNKNOWN_ERROR', error.message ?? res.statusText)
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }
  return res.json()
}

/**
 * Streaming-response variant. Mirrors `request`'s 30s timeout, 401
 * redirect, and error-envelope parsing, but returns the raw
 * `Response` so the caller can `.blob()` / `.body` it. Used by CSV
 * export (the body is a stream, not JSON).
 *
 * On a non-2xx response the function throws `ApiError` per the same
 * contract as `request`, so callers don't need their own
 * status-code ladder.
 */
async function requestRaw(path: string, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  // Lift `init.signal` into a local so the narrowing is explicit
  // to static analysers (CodeQL otherwise flags `init.signal` on
  // the same line as `init?.signal` as a potential undefined deref).
  const callerSignal = init?.signal
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal,
      credentials: 'include',
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(408, 'REQUEST_TIMEOUT', 'Request timed out')
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, 'REQUEST_ABORTED', 'Request aborted')
    }
    throw err
  }

  if (!res.ok) {
    if (res.status === 401) {
      // See `request` above: static import, eval-safe cycle.
      useAuthStore.getState().clearAuth()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
      throw new ApiError(401, 'AUTH_SESSION_EXPIRED', 'Session expired')
    }

    const body = await res.json().catch(() => ({}))
    const error = body.error ?? {}
    throw new ApiError(res.status, error.code ?? 'UNKNOWN_ERROR', error.message ?? res.statusText)
  }

  return res
}

/**
 * Like `request`, but also returns the HTTP status code alongside the
 * parsed body. Needed for endpoints where the status code itself carries
 * meaning distinct from the body shape — e.g. `POST /campaigns` returns
 * 201 with the created campaign normally, but 200 with `SplitReviewGroups`
 * when the target hash list is mixed (issue #202 SU3/SU6). `request<T>`
 * collapses that distinction because both are `res.ok`; callers that need
 * to branch on status must use this instead of guessing from body shape.
 * Reuses `requestRaw`'s fetch/timeout/401/error handling so the two
 * functions don't duplicate that logic — only JSON parsing is added here.
 */
async function requestWithStatus<T>(
  path: string,
  init?: RequestInit
): Promise<{ status: number; data: T }> {
  const res = await requestRaw(path, init)
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return { status: res.status, data: undefined as T }
  }
  return { status: res.status, data: (await res.json()) as T }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) }),
  postWithStatus: <T>(path: string, data?: unknown) =>
    requestWithStatus<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  getRaw: (path: string) => requestRaw(path),
}

export { ApiError }
