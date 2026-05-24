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
 * Reset the UI store to its default state.
 */
export function resetUiStore() {
  useUiStore.setState({
    selectedProjectId: null,
    sidebarOpen: true,
  })
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
