import type { MeResponse } from '@hashhive/shared'

import { create } from 'zustand'

import { api } from '../lib/api'
import { useUiStore } from './ui'

interface ProjectMembership {
  projectId: number
  projectName: string
  roles: string[]
}

interface AuthState {
  projects: ProjectMembership[]
  hasFetchedProjects: boolean
  fetchProjects: () => Promise<void>
  clearAuth: () => void
}

/**
 * Reconcile the UI project selection against the server's truth.
 *
 * Post-#159 U6 the server returns `selectedProjectId` on `/me` directly
 * (sourced from `session.session.projectId`). Prefer that value so the
 * UI store is hydrated before the WebSocket subscription opens and
 * before any query-key dependent on `selectedProjectId` fires.
 *
 * Fall back to the legacy behavior (auto-select for single-project
 * users, clear when current selection is no longer a membership) when
 * the server returns null -- a multi-project user pre-selector.
 */
function syncSelectedProject(
  projects: ProjectMembership[],
  serverSelectedProjectId: number | null
) {
  const { selectedProjectId, setSelectedProject } = useUiStore.getState()

  if (serverSelectedProjectId !== null) {
    if (selectedProjectId !== serverSelectedProjectId) {
      setSelectedProject(serverSelectedProjectId)
    }
    return
  }

  if (projects.length === 1 && projects[0]) {
    setSelectedProject(projects[0].projectId)
    return
  }

  if (selectedProjectId !== null && !projects.some((p) => p.projectId === selectedProjectId)) {
    setSelectedProject(null)
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  projects: [],
  hasFetchedProjects: false,

  fetchProjects: async () => {
    try {
      const data = await api.get<MeResponse>('/dashboard/auth/me')
      const projects: ProjectMembership[] = data.projects.map((p) => ({
        projectId: p.id,
        projectName: p.name,
        roles: p.roles,
      }))
      syncSelectedProject(projects, data.selectedProjectId)
      set({ projects, hasFetchedProjects: true })
    } catch (err) {
      // /me failure typically means session expired (lib/api.ts already
      // redirects to /login on 401 before we get here), but log other
      // failures so a silent UX degradation is observable instead of
      // disappearing into a blank state. Treat as "no projects
      // available" so consumers fall through to the selector / login
      // flow rather than spinning forever.
      // eslint-disable-next-line no-console
      console.error('useAuthStore.fetchProjects failed:', err)
      set({ projects: [], hasFetchedProjects: true })
    }
  },

  clearAuth: () => {
    useUiStore.getState().setSelectedProject(null)
    set({ projects: [], hasFetchedProjects: false })
  },
}))
