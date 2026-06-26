import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import {
  useAgentConfig,
  useFleetDefaultConfig,
  useUpdateAgentConfig,
  useUpdateFleetDefaultConfig,
} from '../../src/hooks/use-agent-config'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, createTestQueryClient, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_CONFIG_RESPONSE = {
  config: {
    tuning: { hashcat: { workloadProfile: 3 } },
    hardware: null,
    behavior: null,
    errorHandling: null,
    rawFlags: null,
  },
  effective: {
    tuning: { hashcat: { workloadProfile: 3 } },
    hardware: {},
    behavior: {},
    errorHandling: {},
  },
  sources: {
    tuning: { hashcat: { workloadProfile: 'rig' as const } },
    hardware: {},
    behavior: {},
    errorHandling: {},
  },
}

const FLEET_CONFIG_RESPONSE = {
  config: {
    tuning: { hashcat: { workloadProfile: 2 } },
    hardware: null,
    behavior: null,
    errorHandling: null,
    rawFlags: null,
  },
}

// ─── Test components ─────────────────────────────────────────────────────────

function AgentConfigComponent({ agentId }: { agentId: number }) {
  const { data, isLoading, error } = useAgentConfig(agentId)
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="data">{data ? JSON.stringify(data) : 'no-data'}</span>
      <span data-testid="error">{error ? String(error) : 'no-error'}</span>
    </div>
  )
}

function UpdateAgentConfigComponent({ agentId }: { agentId: number }) {
  const { mutate, isSuccess, error } = useUpdateAgentConfig(agentId)
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          mutate({
            tuning: { hashcat: { workloadProfile: 4 } },
            hardware: null,
            behavior: null,
            errorHandling: null,
            rawFlags: null,
          })
        }
      >
        update
      </button>
      <span data-testid="success">{String(isSuccess)}</span>
      <span data-testid="error">
        {error instanceof Error ? error.message : error ? 'error' : 'no-error'}
      </span>
    </div>
  )
}

function FleetConfigComponent() {
  const { data, isLoading } = useFleetDefaultConfig()
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="data">{data ? JSON.stringify(data) : 'no-data'}</span>
    </div>
  )
}

function UpdateFleetConfigComponent() {
  const { mutate, isSuccess, error } = useUpdateFleetDefaultConfig()
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          mutate({
            tuning: { hashcat: { workloadProfile: 1 } },
            hardware: null,
            behavior: null,
            errorHandling: null,
            rawFlags: null,
          })
        }
      >
        update-fleet
      </button>
      <span data-testid="success">{String(isSuccess)}</span>
      <span data-testid="error">
        {error instanceof Error ? error.message : error ? 'error' : 'no-error'}
      </span>
    </div>
  )
}

function renderWithClient(node: React.ReactNode, qc = createTestQueryClient()) {
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  return qc
}

// ─── useAgentConfig ───────────────────────────────────────────────────────────

describe('useAgentConfig', () => {
  it('returns parsed config data on success', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents/7/config': { status: 200, body: AGENT_CONFIG_RESPONSE },
    })

    renderWithClient(<AgentConfigComponent agentId={7} />)

    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).not.toBe('no-data')
    })

    const data = JSON.parse(screen.getByTestId('data').textContent!)
    expect(data.config.tuning.hashcat.workloadProfile).toBe(3)
    expect(data.sources.tuning.hashcat.workloadProfile).toBe('rig')
  })

  it('does not fetch when agentId is 0', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents/0/config': { status: 200, body: AGENT_CONFIG_RESPONSE },
    })

    renderWithClient(<AgentConfigComponent agentId={0} />)

    await new Promise((r) => setTimeout(r, 80))
    expect(screen.getByTestId('data').textContent).toBe('no-data')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── useUpdateAgentConfig ────────────────────────────────────────────────────

describe('useUpdateAgentConfig', () => {
  it('invalidates agent-config and agent keys on success', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents/7/config': {
        PATCH: { status: 200, body: AGENT_CONFIG_RESPONSE },
      },
    })

    const qc = createTestQueryClient()
    const invalidateSpy = spyOn(qc, 'invalidateQueries')

    renderWithClient(<UpdateAgentConfigComponent agentId={7} />, qc)

    screen.getByText('update').click()

    await waitFor(() => {
      expect(screen.getByTestId('success').textContent).toBe('true')
    })

    // Should have invalidated all three expected keys
    const calls = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)
    expect(calls).toContainEqual(['agent-config', 7])
    expect(calls).toContainEqual(['agent', 7])
    expect(calls).toContainEqual(['agents'])
  })

  it('surfaces error from a failed mutation', async () => {
    fetchMock = mockFetch({
      '/dashboard/agents/7/config': {
        PATCH: {
          status: 400,
          body: { error: { code: 'VALIDATION_FAILED', message: 'Invalid config' } },
        },
      },
    })

    renderWithClient(<UpdateAgentConfigComponent agentId={7} />)

    screen.getByText('update').click()

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).not.toBe('no-error')
    })

    expect(screen.getByTestId('error').textContent).toContain('Invalid config')
  })
})

// ─── useFleetDefaultConfig ───────────────────────────────────────────────────

describe('useFleetDefaultConfig', () => {
  it('returns fleet config data', async () => {
    fetchMock = mockFetch({
      '/dashboard/fleet-agent-config': { status: 200, body: FLEET_CONFIG_RESPONSE },
    })

    renderWithClient(<FleetConfigComponent />)

    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).not.toBe('no-data')
    })

    const data = JSON.parse(screen.getByTestId('data').textContent!)
    expect(data.config.tuning.hashcat.workloadProfile).toBe(2)
  })
})

// ─── useUpdateFleetDefaultConfig ─────────────────────────────────────────────

describe('useUpdateFleetDefaultConfig', () => {
  it('invalidates fleet-agent-config key on success', async () => {
    fetchMock = mockFetch({
      '/dashboard/fleet-agent-config': {
        PATCH: { status: 200, body: FLEET_CONFIG_RESPONSE },
      },
    })

    const qc = createTestQueryClient()
    const invalidateSpy = spyOn(qc, 'invalidateQueries')

    renderWithClient(<UpdateFleetConfigComponent />, qc)

    screen.getByText('update-fleet').click()

    await waitFor(() => {
      expect(screen.getByTestId('success').textContent).toBe('true')
    })

    const calls = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)
    expect(calls).toContainEqual(['fleet-agent-config'])
  })
})
