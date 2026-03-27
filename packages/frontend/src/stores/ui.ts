import { create } from 'zustand';

interface UiState {
  selectedProjectId: number | null;
  sidebarOpen: boolean;
  /** Mobile drawer state — separate from sidebarOpen so desktop toggle is preserved. */
  mobileSidebarOpen: boolean;
  setSelectedProject: (projectId: number | null) => void;
  toggleSidebar: () => void;
  setMobileSidebar: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedProjectId: null,
  sidebarOpen: true,
  mobileSidebarOpen: false,
  setSelectedProject: (projectId) => set({ selectedProjectId: projectId }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setMobileSidebar: (open) => set({ mobileSidebarOpen: open }),
}));
