import { afterEach, describe, expect, it } from 'bun:test'

import { FirstRunChecklist } from '../../src/components/features/first-run-checklist'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, renderWithProviders, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

function statsBody(over: {
  agents?: number
  campaigns?: number
  running?: number
  completed?: number
}) {
  return {
    agents: {
      total: over.agents ?? 0,
      online: 0,
      offline: over.agents ?? 0,
      busy: 0,
      error: 0,
      benchmarked: 0,
    },
    campaigns: {
      total: over.campaigns ?? 0,
      draft: 0,
      running: over.running ?? 0,
      paused: 0,
      completed: over.completed ?? 0,
      cancelled: 0,
    },
    tasks: { pending: 0, running: 0, completed: 0, failed: 0 },
    cracked: { total: 0 },
  }
}

function mockAll(opts: {
  stats: ReturnType<typeof statsBody>
  hashLists?: unknown[]
  wordlists?: unknown[]
  rulelists?: unknown[]
}) {
  return mockFetch({
    '/dashboard/stats': { GET: { status: 200, body: opts.stats } },
    '/dashboard/resources/hash-lists': {
      GET: { status: 200, body: { hashLists: opts.hashLists ?? [] } },
    },
    '/dashboard/resources/wordlists': {
      GET: { status: 200, body: { wordlists: opts.wordlists ?? [] } },
    },
    '/dashboard/resources/rulelists': {
      GET: { status: 200, body: { rulelists: opts.rulelists ?? [] } },
    },
  })
}

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function renderChecklist() {
  useUiStore.setState({ selectedProjectId: 1 })
  return renderWithProviders(<FirstRunChecklist />)
}

describe('FirstRunChecklist', () => {
  it('does not render while there are zero agents (the hero owns that step)', async () => {
    fetchMock = mockAll({ stats: statsBody({ agents: 0 }) })
    renderChecklist()
    await new Promise((r) => setTimeout(r, 80))
    expect(screen.queryByText('Finish setting up')).toBeNull()
  })

  it('shows the remaining steps once an agent exists, with the next step active', async () => {
    fetchMock = mockAll({ stats: statsBody({ agents: 1 }) })
    renderChecklist()

    await waitFor(() => expect(screen.getByText('Finish setting up')).toBeTruthy())
    expect(screen.getByText('1 of 5 done')).toBeTruthy()
    // First incomplete step (hash list) is the active one.
    expect(screen.getByText('Add a hash list')).toBeTruthy()
    expect(screen.getByText('Start ->')).toBeTruthy()
  })

  it('reflects partial progress in the count', async () => {
    fetchMock = mockAll({
      stats: statsBody({ agents: 1, campaigns: 1 }),
      hashLists: [{ id: 1 }],
      wordlists: [{ id: 1 }],
    })
    renderChecklist()
    // agent + hash list + wordlist + campaign done = 4 of 5 (launch remains).
    await waitFor(() => expect(screen.getByText('4 of 5 done')).toBeTruthy())
    expect(screen.getByText('Launch it')).toBeTruthy()
  })

  it('disappears once every step is complete', async () => {
    fetchMock = mockAll({
      stats: statsBody({ agents: 2, campaigns: 1, running: 1 }),
      hashLists: [{ id: 1 }],
      rulelists: [{ id: 1 }],
    })
    renderChecklist()
    await new Promise((r) => setTimeout(r, 80))
    expect(screen.queryByText('Finish setting up')).toBeNull()
  })

  it('does not fetch resource endpoints once a campaign has launched', async () => {
    // statLaunched = true (running: 1) with agents present — resourcesEnabled
    // evaluates to false, so the wordlist/rulelist hooks must not fire.
    fetchMock = mockAll({
      stats: statsBody({ agents: 2, campaigns: 1, running: 1 }),
    })
    renderChecklist()

    // Wait until the stats fetch has resolved — confirms the component has
    // rendered (and evaluated enabled:false) before we inspect the call log.
    // The component returns null once doneCount === steps.length, but the
    // hooks still run so enabled:false is exercised regardless.
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) =>
        typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
      )
      expect(urls.some((u) => u.includes('/dashboard/stats'))).toBe(true)
    })

    const urls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : (c[0] as URL).href
    )
    expect(urls.some((u) => u.includes('/dashboard/resources/wordlists'))).toBe(false)
    expect(urls.some((u) => u.includes('/dashboard/resources/rulelists'))).toBe(false)
  })
})
