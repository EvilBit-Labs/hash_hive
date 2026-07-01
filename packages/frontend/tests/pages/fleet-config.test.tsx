/**
 * Tests for FleetConfigPage (U9).
 *
 * Stub strategy: pre-populate the QueryClient cache via `qc.setQueryData`
 * (transport-level, avoids mock.module and the CI isolation bug).
 *
 * Covered scenarios:
 *  FC1 — happy path: fleet config loads, tuning knobs show correct source
 *         badges, whitelist entries render, no device picker or temp-abort present
 *  FC2 — permission gate: FLEET_CONFIG_MANAGE absent for viewer/contributor —
 *         resolvePermissions confirms admin has it; viewer and contributor do not
 *  FC3 — save flow: editing a knob marks form dirty, Save dispatches PATCH with
 *         correct body, Cancel restores original form state
 */

import type { FleetConfigResponse } from '@hashhive/shared'

import { afterEach, describe, expect, it } from 'bun:test'

import { Permission, resolvePermissions } from '../../src/lib/permissions'
import { FleetConfigPage } from '../../src/pages/fleet-config'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import {
  cleanupAll,
  createTestQueryClient,
  fireEvent,
  renderWithProviders,
  waitFor,
  within,
} from '../test-utils'

afterEach(cleanupAll)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_FLEET_RESPONSE: FleetConfigResponse = {
  config: {
    tuning: {
      hashcat: {
        workloadProfile: 3,
        kernelAccel: 64,
      },
    },
    errorWhitelist: ['out of memory', 'clEnqueueNDRangeKernel'],
  },
}

const EMPTY_FLEET_RESPONSE: FleetConfigResponse = {
  config: {},
}

// Helper: render page with pre-seeded QueryClient.
// staleTime: Infinity prevents React Query from immediately re-fetching the
// pre-seeded data (default staleTime is 0, which triggers a background refetch).
// Returns both the QueryClient and the rendered container for scoped queries.
function renderPage(response: FleetConfigResponse) {
  const qc = createTestQueryClient()
  qc.setQueryDefaults(['fleet-agent-config'], { staleTime: Number.POSITIVE_INFINITY })
  qc.setQueryData(['fleet-agent-config'], response)

  const { container } = renderWithProviders(<FleetConfigPage />, { queryClient: qc })

  return { qc, container }
}

// ─── FC1: Happy path ──────────────────────────────────────────────────────────

describe('FC1 – happy path rendering', () => {
  it('renders heading, source badges, whitelist entries, and no hardware controls', async () => {
    const { container } = renderPage(BASE_FLEET_RESPONSE)
    const scope = within(container)

    // Heading is present immediately (renders before useEffect)
    expect(scope.getByRole('heading', { name: /fleet configuration/i })).toBeDefined()

    // Wait for form to initialize (useEffect fires after first render with data).
    // Once the Save button appears, all knob rows and badges are in the DOM.
    await waitFor(() => {
      expect(scope.getByRole('button', { name: /^save$/i })).toBeDefined()
    })

    // workloadProfile = 3 and kernelAccel = 64 → both 'override' → multiple 'Source: overridden' badges
    expect(scope.getAllByLabelText('Source: overridden').length).toBeGreaterThanOrEqual(1)

    // kernelLoops not set → source 'engine' → badge text 'engine default'
    expect(scope.getAllByText('engine default').length).toBeGreaterThan(0)

    // Whitelist entries from fixture
    expect(scope.getByText('out of memory')).toBeDefined()
    expect(scope.getByText('clEnqueueNDRangeKernel')).toBeDefined()

    // NO device picker or temperature abort (fleet is hardware-free)
    expect(scope.queryByTestId('device-picker')).toBeNull()
    expect(scope.queryByTestId('device-picker-disabled')).toBeNull()
    expect(scope.queryByLabelText(/temperature abort/i)).toBeNull()
    expect(scope.queryByText(/temp abort/i)).toBeNull()
  })

  it('shows "engine default" badge for all knobs when config is empty', async () => {
    const { container } = renderPage(EMPTY_FLEET_RESPONSE)
    const scope = within(container)
    await waitFor(() => {
      const engineBadges = scope.getAllByText('engine default')
      // At least 3 knobs (workload, kernel accel, kernel loops) should show engine default
      expect(engineBadges.length).toBeGreaterThanOrEqual(3)
    })
  })
})

// ─── FC2: Permission gate ─────────────────────────────────────────────────────

describe('FC2 – permission gate for FLEET_CONFIG_MANAGE', () => {
  it('admin role has FLEET_CONFIG_MANAGE permission', () => {
    const perms = resolvePermissions(['admin'])
    expect(perms.has(Permission.FLEET_CONFIG_MANAGE)).toBe(true)
  })

  it('contributor role does NOT have FLEET_CONFIG_MANAGE permission', () => {
    const perms = resolvePermissions(['contributor'])
    expect(perms.has(Permission.FLEET_CONFIG_MANAGE)).toBe(false)
  })

  it('viewer role does NOT have FLEET_CONFIG_MANAGE permission', () => {
    const perms = resolvePermissions(['viewer'])
    expect(perms.has(Permission.FLEET_CONFIG_MANAGE)).toBe(false)
  })
})

// ─── FC3: Save / Cancel flow ──────────────────────────────────────────────────

describe('FC3 – save and cancel flow', () => {
  it('Save and Cancel buttons are disabled when form is not dirty', async () => {
    const { container } = renderPage(BASE_FLEET_RESPONSE)
    const scope = within(container)

    // Wait for form to initialize (useEffect fires after first render)
    const saveBtn = await waitFor(() => scope.getByRole('button', { name: /^save$/i }))
    const cancelBtn = scope.getByRole('button', { name: /^cancel$/i })

    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('editing a knob enables Save/Cancel and shows "Unsaved changes" indicator', async () => {
    const { container } = renderPage(BASE_FLEET_RESPONSE)
    const scope = within(container)

    // Wait for form to initialize, then find kernel loops input by its id
    await waitFor(() => scope.getByRole('button', { name: /^save$/i }))

    const kernelLoopsInput = container.querySelector('#fleet-config-kernel-loops')
    expect(kernelLoopsInput).toBeDefined()
    fireEvent.change(kernelLoopsInput!, { target: { value: '128' } })

    await waitFor(() => {
      expect(scope.getByText(/unsaved changes/i)).toBeDefined()
      expect((scope.getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(
        false
      )
    })
  })

  it('Cancel restores the original form state and hides "Unsaved changes"', async () => {
    const { container } = renderPage(BASE_FLEET_RESPONSE)
    const scope = within(container)

    await waitFor(() => scope.getByRole('button', { name: /^save$/i }))

    const kernelLoopsInput = container.querySelector('#fleet-config-kernel-loops')
    expect(kernelLoopsInput).toBeDefined()
    fireEvent.change(kernelLoopsInput!, { target: { value: '256' } })

    await waitFor(() => {
      expect(scope.getByText(/unsaved changes/i)).toBeDefined()
    })

    fireEvent.click(scope.getByRole('button', { name: /^cancel$/i }))

    await waitFor(() => {
      expect(scope.queryByText(/unsaved changes/i)).toBeNull()
      expect((scope.getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(
        true
      )
    })
  })

  it('Save sends PATCH to /dashboard/fleet-agent-config with the updated config', async () => {
    const fetchMock = mockFetch({
      '/dashboard/fleet-agent-config': {
        PATCH: { status: 200, body: BASE_FLEET_RESPONSE },
      },
    })

    try {
      const { container } = renderPage(BASE_FLEET_RESPONSE)
      const scope = within(container)

      // Wait for form to initialize, then add a whitelist pattern
      const patternInput = await waitFor(() => scope.getByLabelText(/new whitelist pattern/i))
      fireEvent.change(patternInput, { target: { value: 'cuda error' } })
      fireEvent.click(scope.getByRole('button', { name: /^add$/i }))

      await waitFor(() => {
        expect(scope.getByText('cuda error')).toBeDefined()
      })

      fireEvent.click(scope.getByRole('button', { name: /^save$/i }))

      // Verify the PATCH was called
      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
      })

      // Find the PATCH call and inspect the request body
      const patchCall = fetchMock.mock.calls.find(
        ([, init]: [unknown, RequestInit | undefined]) =>
          (init?.method ?? '').toUpperCase() === 'PATCH'
      )
      expect(patchCall).toBeDefined()

      const [, init] = patchCall as [unknown, RequestInit]
      const body = JSON.parse(init.body as string) as { errorWhitelist?: string[] }
      expect(Array.isArray(body.errorWhitelist)).toBe(true)
      expect(body.errorWhitelist).toContain('cuda error')
    } finally {
      restoreFetch(fetchMock)
    }
  })
})
