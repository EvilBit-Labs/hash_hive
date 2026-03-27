import { useUiStore } from '../stores/ui';

const API_BASE = '/api/v1';

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getProjectHeaders(): Record<string, string> {
  const projectId = useUiStore.getState().selectedProjectId;
  return projectId ? { 'X-Project-Id': String(projectId) } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...getProjectHeaders(),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401) {
      // Session expired -- clear auth state and redirect to login
      const { useAuthStore } = await import('../stores/auth');
      useAuthStore.getState().clearAuth();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      throw new ApiError(401, 'AUTH_SESSION_EXPIRED', 'Session expired');
    }

    const body = await res.json().catch(() => ({}));
    const error = body.error ?? {};
    throw new ApiError(res.status, error.code ?? 'UNKNOWN_ERROR', error.message ?? res.statusText);
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export { ApiError };
