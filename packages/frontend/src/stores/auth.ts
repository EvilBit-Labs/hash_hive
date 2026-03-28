import { create } from 'zustand';
import { api } from '../lib/api';
import { useUiStore } from './ui';

interface User {
  id: number;
  email: string;
  name: string;
  projects: Array<{
    projectId: number;
    projectName: string;
    roles: string[];
  }>;
}

interface MeResponse {
  user: { id: number; email: string; name: string; status: string };
  projects: Array<{ id: number; name: string; slug: string; roles: string[] }>;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  fetchUser: () => Promise<void>;
  clearAuth: () => void;
}

const AUTH_BASE = '/api/auth';

/** Reconcile the UI project selection against the user's actual memberships. */
function syncSelectedProject(projects: User['projects']) {
  const { selectedProjectId, setSelectedProject } = useUiStore.getState();

  // Auto-select if exactly one project
  if (projects.length === 1 && projects[0]) {
    setSelectedProject(projects[0].projectId);
    return;
  }

  // Clear stale selection if the user lost access to the previously selected project
  if (selectedProjectId !== null && !projects.some((p) => p.projectId === selectedProjectId)) {
    setSelectedProject(null);
  }
}

/** Fetch /me and map the API response into the local User shape. */
async function fetchAndMapUser(): Promise<User> {
  const data = await api.get<MeResponse>('/dashboard/auth/me');
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name,
    projects: data.projects.map((p) => ({
      projectId: p.id,
      projectName: p.name,
      roles: p.roles,
    })),
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      // BetterAuth handles login at /api/auth/sign-in/email
      const signInRes = await fetch(`${AUTH_BASE}/sign-in/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!signInRes.ok) {
        if (signInRes.status >= 500) {
          throw new Error('Authentication service is temporarily unavailable');
        }
        const body: unknown = await signInRes.json().catch(() => null);
        const message =
          typeof body === 'object' &&
          body !== null &&
          'message' in body &&
          typeof (body as Record<string, unknown>)['message'] === 'string'
            ? ((body as Record<string, unknown>)['message'] as string)
            : 'Invalid email or password';
        throw new Error(message);
      }

      const user = await fetchAndMapUser();
      set({ user, isAuthenticated: true, isLoading: false });
      syncSelectedProject(user.projects);
    } catch (err) {
      set({ isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    // BetterAuth handles logout at /api/auth/sign-out
    // Clear local state regardless of server response (network may be down)
    try {
      await fetch(`${AUTH_BASE}/sign-out`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      // Server-side session cleanup failed; clear local state anyway
    }
    useUiStore.getState().setSelectedProject(null);
    set({ user: null, isAuthenticated: false });
  },

  clearAuth: () => {
    useUiStore.getState().setSelectedProject(null);
    set({ user: null, isAuthenticated: false, isLoading: false });
  },

  fetchUser: async () => {
    try {
      const user = await fetchAndMapUser();
      syncSelectedProject(user.projects);
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      // 401 is expected (no session); other errors are handled by the API client's
      // global 401 interceptor which redirects to login. In all cases, clear state.
      useUiStore.getState().setSelectedProject(null);
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
