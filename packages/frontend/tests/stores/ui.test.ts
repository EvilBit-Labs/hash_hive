import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { useUiStore } from '../../src/stores/ui'

const STORAGE_KEY = 'hashhive.ui.v1'

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    selectedProjectId: null,
    sidebarOpen: true,
    mobileSidebarOpen: false,
    rememberLastProject: false,
    lastProjectId: null,
  })
})

afterEach(() => {
  window.localStorage.clear()
})

describe('useUiStore', () => {
  it('defaults rememberLastProject to false and lastProjectId to null', () => {
    const s = useUiStore.getState()
    expect(s.rememberLastProject).toBe(false)
    expect(s.lastProjectId).toBeNull()
  })

  it('setRememberLastProject updates the flag', () => {
    useUiStore.getState().setRememberLastProject(true)
    expect(useUiStore.getState().rememberLastProject).toBe(true)
  })

  it('setLastProjectId updates the id', () => {
    useUiStore.getState().setLastProjectId(42)
    expect(useUiStore.getState().lastProjectId).toBe(42)

    useUiStore.getState().setLastProjectId(null)
    expect(useUiStore.getState().lastProjectId).toBeNull()
  })

  it('persists rememberLastProject and lastProjectId to localStorage under the versioned key', () => {
    useUiStore.getState().setRememberLastProject(true)
    useUiStore.getState().setLastProjectId(7)

    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as {
      state: { rememberLastProject?: boolean; lastProjectId?: number | null }
    }
    expect(parsed.state.rememberLastProject).toBe(true)
    expect(parsed.state.lastProjectId).toBe(7)
  })

  it('does NOT persist selectedProjectId (server-managed, must not leak across reloads)', () => {
    useUiStore.getState().setSelectedProject(99)

    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { state: Record<string, unknown> }
      expect(parsed.state).not.toHaveProperty('selectedProjectId')
    }
    // The in-memory value is still set; we only care that storage didn't capture it.
    expect(useUiStore.getState().selectedProjectId).toBe(99)
  })

  it('persists sidebarOpen across writes', () => {
    useUiStore.getState().toggleSidebar() // → false
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw as string) as { state: { sidebarOpen?: boolean } }
    expect(parsed.state.sidebarOpen).toBe(false)
  })
})
