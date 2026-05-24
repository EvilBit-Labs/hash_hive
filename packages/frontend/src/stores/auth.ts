import { create } from 'zustand'

import { api } from '../lib/api'
import { useUiStore } from './ui'

interface ProjectMembership {
  projectId: number
  projectName: string
  roles: string[]
}

interface MeResponse {
  user: { id: number; email: string; name: string; status: string }
  projects: Array<{ id: number; name: string; slug: string; roles: string[] }>
}

interface AuthState {
  projects: ProjectMembership[]
  hasFetchedProjects: boolean
  fetchProjects: () => Promise<void>
  clearAuth: () => void
}

/** Reconcile the UI project selection against the user's actual memberships. */
function syncSelectedProject(projects: ProjectMembership[]) {
  const { selectedProjectId, setSelectedProject } = useUiStore.getState()

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
      syncSelectedProject(projects)
      set({ projects, hasFetchedProjects: true })
    } catch {
      set({ projects: [], hasFetchedProjects: true })
    }
  },

  clearAuth: () => {
    useUiStore.getState().setSelectedProject(null)
    set({ projects: [], hasFetchedProjects: false })
  },
}))
