import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UiState {
  selectedProjectId: number | null
  sidebarOpen: boolean
  /** Mobile drawer state — separate from sidebarOpen so desktop toggle is preserved. */
  mobileSidebarOpen: boolean
  /** Whether to auto-select the last-used project on next login. Persisted. */
  rememberLastProject: boolean
  /** The last project the user explicitly selected. Persisted alongside the flag. */
  lastProjectId: number | null
  setSelectedProject: (projectId: number | null) => void
  toggleSidebar: () => void
  setMobileSidebar: (open: boolean) => void
  setRememberLastProject: (value: boolean) => void
  setLastProjectId: (id: number | null) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      sidebarOpen: true,
      mobileSidebarOpen: false,
      rememberLastProject: false,
      lastProjectId: null,
      setSelectedProject: (projectId) => set({ selectedProjectId: projectId }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setMobileSidebar: (open) => set({ mobileSidebarOpen: open }),
      setRememberLastProject: (value) => set({ rememberLastProject: value }),
      setLastProjectId: (id) => set({ lastProjectId: id }),
    }),
    {
      name: 'hashhive.ui.v1',
      // Only persist UX preferences. `selectedProjectId` mirrors the
      // server-managed session.projectId from #159 — caching it locally
      // would race the server's truth on every page load.
      // `mobileSidebarOpen` is ephemeral per-session.
      partialize: (state) => ({
        rememberLastProject: state.rememberLastProject,
        lastProjectId: state.lastProjectId,
        sidebarOpen: state.sidebarOpen,
      }),
    }
  )
)
