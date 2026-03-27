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

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      // BetterAuth handles login at /api/auth/sign-in/email
      await fetch(`${AUTH_BASE}/sign-in/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.message ?? 'Invalid email or password');
        }
      });

      // Fetch user profile from our custom /me endpoint
      const data = await api.get<MeResponse>('/dashboard/auth/me');
      const user: User = {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        projects: data.projects.map((p) => ({
          projectId: p.id,
          projectName: p.name,
          roles: p.roles,
        })),
      };
      set({ user, isAuthenticated: true, isLoading: false });

      // Auto-select project if user has exactly one
      if (user.projects.length === 1 && user.projects[0]) {
        useUiStore.getState().setSelectedProject(user.projects[0].projectId);
      }
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
      const data = await api.get<MeResponse>('/dashboard/auth/me');
      const user: User = {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        projects: data.projects.map((p) => ({
          projectId: p.id,
          projectName: p.name,
          roles: p.roles,
        })),
      };
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
