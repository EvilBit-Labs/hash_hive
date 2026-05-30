import { useAuthStore } from '../../src/stores/auth'
import { useCampaignWizard } from '../../src/stores/campaign-wizard'
import { useUiStore } from '../../src/stores/ui'

/**
 * Reset the auth store to its default (logged-out) state.
 */
export function resetAuthStore() {
  useAuthStore.setState({
    projects: [],
    hasFetchedProjects: false,
  })
}

/**
 * Reset the UI store to its default state and clear persisted preferences.
 *
 * The store uses zustand/middleware `persist` under the key
 * `hashhive.ui.v1`. Without clearing localStorage between tests, a
 * test that writes `rememberLastProject = true` would leak into
 * subsequent tests' initial state.
 */
export function resetUiStore() {
  useUiStore.setState({
    selectedProjectId: null,
    sidebarOpen: true,
    mobileSidebarOpen: false,
    rememberLastProject: false,
    lastProjectId: null,
  })
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem('hashhive.ui.v1')
  }
}

/**
 * Reset the campaign wizard store to its initial state.
 */
export function resetCampaignWizard() {
  useCampaignWizard.getState().reset()
}

/**
 * Reset all Zustand stores to their default states.
 * Call in `afterEach()` to prevent cross-test state leakage.
 */
export function resetAllStores() {
  resetAuthStore()
  resetUiStore()
  resetCampaignWizard()
}
