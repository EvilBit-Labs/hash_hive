import { useUiStore } from '../stores/ui'

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

function getProjectHeaders(): Record<string, string> {
  const projectId = useUiStore.getState().selectedProjectId
  return projectId ? { 'X-Project-Id': String(projectId) } : {}
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
    const mergedHeaders = new Headers({
      'Content-Type': 'application/json',
      ...getProjectHeaders(),
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
      // Session expired -- clear auth state and redirect to login
      const { useAuthStore } = await import('../stores/auth')
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

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export { ApiError }
