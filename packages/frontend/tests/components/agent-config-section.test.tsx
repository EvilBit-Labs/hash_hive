/**
 * Tests for AgentConfigSection (U8).
 *
 * Stub strategy: pre-populate the QueryClient cache via `qc.setQueryData`
 * (transport-level, avoids mock.module and the CI isolation bug).
 *
 * Covered scenarios:
 *  AE1 — rig overrides one tuning knob: shows "overridden" badge + reset; others show "inherited"
 *  AE3 — typing `-w 1` in additional-flags surfaces a conflict note
 *  AE4 — two-GPU profile yields exactly two device checkboxes; no free-text input
 *  Edge — absent hardwareProfile → disabled device picker with message
 *  Edge — reset clears workload profile override (returns form to '' / inherited state)
 *  Edge — Save sends only changed fields; a 0-value is preserved (not dropped by falsy guard)
 */

import type { AgentConfigResponse } from '@hashhive/shared'

import { afterEach, describe, expect, it, mock } from 'bun:test'

import { AgentConfigSection } from '../../src/components/features/agent-config-section'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import {
  cleanupAll,
  createTestQueryClient,
  fireEvent,
  renderWithProviders,
  screen,
  waitFor,
} from '../test-utils'

afterEach(cleanupAll)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_RESPONSE: AgentConfigResponse = {
  config: {
    tuning: { hashcat: { workloadProfile: 3 } },
    hardware: {},
    errorWhitelist: [],
  },
  effective: {
    tuning: { hashcat: { workloadProfile: 3 } },
    hardware: {},
  },
  sources: {
    tuning: {
      hashcat: {
        workloadProfile: 'override',
        kernelAccel: 'fleet',
        kernelLoops: 'fleet',
        rawFlags: 'engine',
      },
    },
    hardware: {},
    errorWhitelist: 'engine',
  },
}

const TWO_GPU_PROFILE = {
  gpus: [
    { model: 'RTX 4090', memoryMb: 24576 },
    { model: 'RTX 3080', memoryMb: 10240 },
  ],
}

const LAST_SEEN = '2026-06-26T12:00:00.000Z'

// Helper: render with a pre-seeded QueryClient.
// staleTime: Infinity prevents React Query from immediately re-fetching the
// pre-seeded data (default staleTime is 0, which would trigger a background
// refetch that fails because no fetch mock is wired for the config endpoint).
function renderSection(
  configResponse: AgentConfigResponse,
  options: {
    hardwareProfile?: Record<string, unknown> | null
    lastSeenAt?: string | null
    agentId?: number
  } = {}
) {
  const { hardwareProfile = null, lastSeenAt = null, agentId = 42 } = options
  const qc = createTestQueryClient()
  qc.setQueryDefaults(['agent-config', agentId], { staleTime: Number.POSITIVE_INFINITY })
  qc.setQueryData(['agent-config', agentId], configResponse)

  renderWithProviders(
    <AgentConfigSection
      agentId={agentId}
      hardwareProfile={hardwareProfile}
      lastSeenAt={lastSeenAt}
    />,
    { queryClient: qc }
  )

  return qc
}

// ─── AE1: source badges ────────────────────────────────────────────────────────

describe('AE1 – source badges and reset control', () => {
  it('shows "overridden" badge for workload profile when source is override', async () => {
    renderSection(BASE_RESPONSE)
    await waitFor(() => {
      expect(screen.getByText('overridden')).toBeDefined()
    })
  })

  it('shows "inherited" badge for kernelAccel when source is fleet', async () => {
    renderSection(BASE_RESPONSE)
    await waitFor(() => {
      const badges = screen.getAllByText('inherited')
      // kernelAccel and kernelLoops both come from fleet
      expect(badges.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('renders a reset button only for overridden knobs', async () => {
    renderSection(BASE_RESPONSE)
    // Only workloadProfile is override; should have exactly one reset button
    await waitFor(() => {
      const resetBtns = screen
        .getAllByRole('button')
        .filter((b) => b.textContent?.trim() === 'reset')
      expect(resetBtns.length).toBe(1)
    })
  })

  it('shows "engine default" badge for rawFlags when source is engine', async () => {
    renderSection(BASE_RESPONSE)
    await waitFor(() => {
      expect(screen.getByText('engine default')).toBeDefined()
    })
  })

  it('clicking reset removes the overridden badge and reset button', async () => {
    renderSection(BASE_RESPONSE)

    // Wait for form to initialize before interacting
    let resetBtn: HTMLElement | undefined
    await waitFor(() => {
      resetBtn = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'reset')
      expect(resetBtn).toBeDefined()
    })
    if (!resetBtn) return

    fireEvent.click(resetBtn)

    await waitFor(() => {
      // After reset, the workloadProfile is cleared; form becomes dirty
      // but no reset button remains for workloadProfile
      const remainingResets = screen
        .getAllByRole('button')
        .filter((b) => b.textContent?.trim() === 'reset')
      expect(remainingResets.length).toBe(0)
    })
  })
})

// ─── AE3: raw-flag conflict detection ─────────────────────────────────────────

describe('AE3 – raw-flag conflict detection', () => {
  it('shows conflict note when -w is typed in additional flags', async () => {
    renderSection(BASE_RESPONSE)

    // Wait for form to initialize before interacting with inputs
    const flagInput = await screen.findByLabelText('Additional hashcat flags')
    fireEvent.change(flagInput, { target: { value: '-w 1' } })

    await waitFor(() => {
      expect(screen.getByTestId('flag-conflict-note')).toBeDefined()
    })

    const note = screen.getByTestId('flag-conflict-note')
    expect(note.textContent).toContain('workload profile')
  })

  it('shows conflict note when --kernel-accel is typed', async () => {
    renderSection(BASE_RESPONSE)

    const flagInput = await screen.findByLabelText('Additional hashcat flags')
    fireEvent.change(flagInput, { target: { value: '--kernel-accel=64' } })

    await waitFor(() => {
      expect(screen.getByTestId('flag-conflict-note')).toBeDefined()
    })

    expect(screen.getByTestId('flag-conflict-note').textContent).toContain('kernel accel')
  })

  it('does not show conflict note for innocuous flags like --force', async () => {
    renderSection(BASE_RESPONSE)

    const flagInput = await screen.findByLabelText('Additional hashcat flags')
    fireEvent.change(flagInput, { target: { value: '--force' } })

    expect(screen.queryByTestId('flag-conflict-note')).toBeNull()
  })

  it('clears conflict note when the offending flag is removed', async () => {
    renderSection(BASE_RESPONSE)

    const flagInput = screen.getByLabelText('Additional hashcat flags')
    fireEvent.change(flagInput, { target: { value: '-w 1' } })

    await waitFor(() => {
      expect(screen.getByTestId('flag-conflict-note')).toBeDefined()
    })

    fireEvent.change(flagInput, { target: { value: '--force' } })

    await waitFor(() => {
      expect(screen.queryByTestId('flag-conflict-note')).toBeNull()
    })
  })
})

// ─── AE4: two-GPU hardware profile ────────────────────────────────────────────

describe('AE4 – device picker with two GPUs', () => {
  it('renders exactly two device checkboxes for a two-GPU profile', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: TWO_GPU_PROFILE })

    const picker = await screen.findByTestId('device-picker')
    const checkboxes = picker.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes.length).toBe(2)
  })

  it('labels devices by GPU model name', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: TWO_GPU_PROFILE })

    await waitFor(() => {
      expect(screen.getByText('RTX 4090')).toBeDefined()
      expect(screen.getByText('RTX 3080')).toBeDefined()
    })
  })

  it('does not render the disabled fallback message when GPUs are present', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: TWO_GPU_PROFILE })

    // Wait for form to initialize, then confirm disabled picker is absent
    await screen.findByTestId('device-picker')
    expect(screen.queryByTestId('device-picker-disabled')).toBeNull()
  })

  it('does not render a free-text device input', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: TWO_GPU_PROFILE })

    // The device area should contain only checkboxes, no text input
    const picker = await screen.findByTestId('device-picker')
    const textInputs = picker.querySelectorAll('input[type="text"]')
    expect(textInputs.length).toBe(0)
  })
})

// ─── Edge: absent / empty hardware profile ────────────────────────────────────

describe('Edge – absent hardwareProfile shows disabled device picker', () => {
  it('renders the disabled fallback when hardwareProfile is null', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: null })

    await waitFor(() => {
      expect(screen.getByTestId('device-picker-disabled')).toBeDefined()
    })
  })

  it('renders the disabled fallback when gpus array is empty', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: { gpus: [] } })

    await waitFor(() => {
      expect(screen.getByTestId('device-picker-disabled')).toBeDefined()
    })
  })

  it('shows lastSeenAt timestamp in the disabled fallback message', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: null, lastSeenAt: LAST_SEEN })

    const fallback = await screen.findByTestId('device-picker-disabled')
    // Should mention "Last seen" somewhere in the fallback message
    expect(fallback.textContent).toContain('Last seen')
  })

  it('does not render the live device picker when hardware is absent', async () => {
    renderSection(BASE_RESPONSE, { hardwareProfile: null })

    // Wait for form to initialize, then confirm live picker is absent
    await screen.findByTestId('device-picker-disabled')
    expect(screen.queryByTestId('device-picker')).toBeNull()
  })
})

// ─── Edge: reset returns knob to inherited ────────────────────────────────────

describe('Edge – reset knob behaviour', () => {
  it('marks form dirty after reset (workloadProfile cleared from override)', async () => {
    renderSection(BASE_RESPONSE)

    // Wait for form to initialize; initially form is clean
    let resetBtn: HTMLElement | undefined
    await waitFor(() => {
      resetBtn = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'reset')
      expect(resetBtn).toBeDefined()
    })
    // Before clicking reset, confirm no dirty indicator
    expect(screen.queryByText('Unsaved changes')).toBeNull()

    if (!resetBtn) throw new Error('reset button not found')
    fireEvent.click(resetBtn)

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeDefined()
    })
  })
})

// ─── Edge: Save sends only changed fields ────────────────────────────────────

describe('Edge – Save payload', () => {
  it('Save button is disabled when form is unmodified', async () => {
    renderSection(BASE_RESPONSE)

    // Wait for form to initialize, then confirm Save is disabled
    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: /save/i })
      expect(saveBtn).toBeDefined()
    })
    const saveBtn = screen.getByRole('button', { name: /save/i })
    expect(saveBtn.hasAttribute('disabled')).toBe(true)
  })

  it('Save button becomes enabled after a field change', async () => {
    renderSection(BASE_RESPONSE)

    const kernelAccelInput = (await screen.findByLabelText('Kernel accel', {
      exact: false,
    })) as HTMLInputElement
    fireEvent.change(kernelAccelInput, { target: { value: '64' } })

    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: /save/i })
      expect(saveBtn.hasAttribute('disabled')).toBe(false)
    })
  })

  it('sends a PATCH with only the changed field (kernelAccel)', async () => {
    let capturedBody: unknown = null
    const fetchMock = mockFetch({
      '/dashboard/agents/42/config': {
        PATCH: {
          status: 200,
          body: BASE_RESPONSE,
        },
      },
    })

    // Intercept the actual fetch call to capture the body
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/dashboard/agents/42/config') && init?.method === 'PATCH') {
        capturedBody = JSON.parse(init.body as string)
      }
      return originalFetch(input, init)
    }) as typeof fetch

    try {
      renderSection(BASE_RESPONSE, { agentId: 42 })

      // Wait for form to initialize before interacting
      const kernelAccelInput = (await screen.findByLabelText('Kernel accel', {
        exact: false,
      })) as HTMLInputElement
      fireEvent.change(kernelAccelInput, { target: { value: '64' } })

      await waitFor(() => {
        const saveBtn = screen.getByRole('button', { name: /save/i })
        expect(saveBtn.hasAttribute('disabled')).toBe(false)
      })

      const saveBtn = screen.getByRole('button', { name: /save/i })
      fireEvent.click(saveBtn)

      await waitFor(() => {
        expect(capturedBody).not.toBeNull()
      })

      // Should include kernelAccel but NOT workloadProfile (unchanged)
      const body = capturedBody as Record<string, unknown>
      const hashcat = (body['tuning'] as Record<string, unknown>)?.['hashcat'] as
        | Record<string, unknown>
        | undefined
      expect(hashcat?.['kernelAccel']).toBe(64)
      expect(hashcat?.['workloadProfile']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      restoreFetch(fetchMock)
    }
  })

  it('preserves a 0-value tempAbort in the patch (not dropped by falsy guard)', async () => {
    let capturedBody: unknown = null

    const responseWithTempAbort: AgentConfigResponse = {
      ...BASE_RESPONSE,
      config: {
        ...BASE_RESPONSE.config,
        hardware: { tempAbort: 85 },
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/dashboard/agents/99/config') && init?.method === 'PATCH') {
        capturedBody = JSON.parse(init.body as string)
      }
      return Promise.resolve(
        new Response(JSON.stringify(responseWithTempAbort), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }) as typeof fetch

    try {
      const qc = createTestQueryClient()
      qc.setQueryData(['agent-config', 99], responseWithTempAbort)

      renderWithProviders(
        <AgentConfigSection agentId={99} hardwareProfile={null} lastSeenAt={null} />,
        { queryClient: qc }
      )

      // Change tempAbort from 85 to 0 (a valid falsy value)
      const tempAbortInput = screen.getByLabelText('Temperature abort threshold', {
        exact: false,
      }) as HTMLInputElement
      fireEvent.change(tempAbortInput, { target: { value: '0' } })

      await waitFor(() => {
        const saveBtn = screen.getByRole('button', { name: /save/i })
        expect(saveBtn.hasAttribute('disabled')).toBe(false)
      })

      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => {
        expect(capturedBody).not.toBeNull()
      })

      const body = capturedBody as Record<string, unknown>
      const hw = body['hardware'] as Record<string, unknown> | undefined
      // tempAbort: 0 is valid; must not be dropped
      expect(hw?.['tempAbort']).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── Smoke: loading and error states ─────────────────────────────────────────

describe('Loading and error states', () => {
  it('renders skeleton placeholders while loading', () => {
    const qc = createTestQueryClient()
    // Do NOT pre-seed the cache — query will be in loading state

    renderWithProviders(
      <AgentConfigSection agentId={1} hardwareProfile={null} lastSeenAt={null} />,
      { queryClient: qc }
    )

    // Skeleton elements are present
    const skeletons = document.querySelectorAll('[aria-hidden="true"]')
    expect(skeletons.length).toBeGreaterThanOrEqual(1)
  })
})
