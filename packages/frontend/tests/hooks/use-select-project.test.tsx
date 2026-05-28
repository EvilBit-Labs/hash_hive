import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { useSelectProject } from '../../src/hooks/use-select-project'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, createTestQueryClient, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

interface ProbeProps {
  projectId: number
  onErr?: (m: string) => void
}

function Probe({ projectId, onErr }: ProbeProps) {
  const m = useSelectProject({ onError: onErr })
  return (
    <div>
      <button
        type="button"
        data-testid="trigger"
        onClick={() => {
          m.mutate(projectId)
        }}
      >
        select
      </button>
      <span data-testid="pending">{m.isPending ? 'pending' : 'idle'}</span>
    </div>
  )
}

function renderProbe(node: React.ReactNode, qc?: QueryClient) {
  return render(
    <QueryClientProvider client={qc ?? createTestQueryClient()}>{node}</QueryClientProvider>
  )
}

describe('useSelectProject', () => {
  it('POSTs /dashboard/projects/select with the project id and updates the ui store on success', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })

    renderProbe(<Probe projectId={7} />)
    screen.getByTestId('trigger').click()

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(7)
    })

    // Verify the request shape: POST, body { projectId: 7 }
    const call = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      return url.includes('/dashboard/projects/select')
    })
    expect(call).toBeDefined()
    const [, init] = call as [unknown, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ projectId: 7 })
  })

  it('invalidates queries on success', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { POST: { status: 200, body: {} } },
    })

    const qc = createTestQueryClient()
    let invalidateCallCount = 0
    const originalInvalidate = qc.invalidateQueries.bind(qc)
    qc.invalidateQueries = ((...args: Parameters<typeof originalInvalidate>) => {
      invalidateCallCount++
      return originalInvalidate(...args)
    }) as typeof qc.invalidateQueries

    renderProbe(<Probe projectId={3} />, qc)
    screen.getByTestId('trigger').click()

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(3)
    })

    expect(invalidateCallCount).toBeGreaterThan(0)
  })

  it('does not mutate the ui store when the server returns 403', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': {
        POST: {
          status: 403,
          body: { error: { code: 'RBAC_FORBIDDEN', message: 'not a member of this project' } },
        },
      },
    })

    let captured: string | null = null
    renderProbe(
      <Probe
        projectId={9}
        onErr={(m) => {
          captured = m
        }}
      />
    )
    screen.getByTestId('trigger').click()

    await waitFor(() => {
      expect(captured).not.toBeNull()
    })

    expect(captured).toContain('not a member')
    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })

  it('does not mutate the ui store when the server returns 412 (no membership)', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': {
        POST: {
          status: 412,
          body: { error: { code: 'PROJECT_NOT_FOUND', message: 'project no longer exists' } },
        },
      },
    })

    let captured: string | null = null
    renderProbe(
      <Probe
        projectId={42}
        onErr={(m) => {
          captured = m
        }}
      />
    )
    screen.getByTestId('trigger').click()

    await waitFor(() => {
      expect(captured).not.toBeNull()
    })

    expect(captured).toContain('no longer exists')
    expect(useUiStore.getState().selectedProjectId).toBeNull()
  })
})
