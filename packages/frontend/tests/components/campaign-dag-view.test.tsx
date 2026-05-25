import type { CampaignAttackRow } from '@hashhive/shared'

import { afterEach, describe, expect, it, mock } from 'bun:test'

import { cleanupAll, renderWithProviders, screen } from '../test-utils'

/**
 * Factory for test attack rows. The DAG component reads only id, mode,
 * status, and dependencies; the other CampaignAttackRow fields are
 * filled with neutral defaults so the literal matches the wire shape.
 */
function makeAttack(overrides: Partial<CampaignAttackRow> = {}): CampaignAttackRow {
  return {
    id: 1,
    campaignId: 1,
    mode: 0,
    status: 'pending',
    wordlistId: null,
    rulelistId: null,
    masklistId: null,
    dependencies: null,
    ...overrides,
  }
}

// ReactFlow needs ResizeObserver and DOMRect APIs happy-dom doesn't ship
// with. Replace the heavy graph renderer with a deterministic stub that
// preserves the inputs we want to assert on (node count, edge count,
// per-attack status styling). Lazy + Suspense in the page wrapper means
// the real bundle never loads in this test.
mock.module('reactflow', () => {
  function ReactFlow({
    nodes,
    edges,
  }: {
    nodes: Array<{
      id: string
      data: { label: string }
      style?: Record<string, string | undefined>
    }>
    edges: Array<{ id: string; source: string; target: string }>
  }) {
    return (
      <div data-testid="react-flow-stub">
        <ul data-testid="dag-nodes">
          {nodes.map((n) => (
            <li key={n.id} data-node-id={n.id} data-node-bg={n.style?.['background'] ?? ''}>
              {n.data.label}
            </li>
          ))}
        </ul>
        <ul data-testid="dag-edges">
          {edges.map((e) => (
            <li key={e.id} data-edge-source={e.source} data-edge-target={e.target}>
              {e.source} -&gt; {e.target}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  // Expose the broader reactflow API so this mock can satisfy other test
  // files (notably tests/pages/campaign-create.test.tsx) that share the
  // process-level module cache after this file's mock loads first.
  function useNodesState<T>(initial: T) {
    return [initial, () => {}, () => {}] as const
  }
  function useEdgesState<T>(initial: T) {
    return [initial, () => {}, () => {}] as const
  }
  return {
    default: ReactFlow,
    Background: () => null,
    Controls: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState,
    useEdgesState,
  }
})

// Stub reactflow's CSS import — happy-dom's CSS loader does not handle
// the module's stylesheet.
mock.module('reactflow/dist/style.css', () => ({}))

// Import AFTER mocks so the stub flows through.
const { CampaignDagView } = await import('../../src/components/features/campaign-dag-view')

afterEach(cleanupAll)

describe('CampaignDagView', () => {
  it('renders an empty state when no attacks are configured', () => {
    renderWithProviders(<CampaignDagView attacks={[]} />)
    expect(screen.getByText('No attacks configured.')).toBeDefined()
  })

  it('renders one node per attack', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[
          makeAttack({ id: 1, mode: 0, status: 'pending', dependencies: null }),
          makeAttack({ id: 2, mode: 3, status: 'running', dependencies: [1] }),
          makeAttack({ id: 3, mode: 0, status: 'completed', dependencies: [2] }),
        ]}
      />
    )

    const items = screen.getByTestId('dag-nodes').querySelectorAll('li')
    expect(items).toHaveLength(3)
  })

  it('renders an edge for each dependency reference', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[
          makeAttack({ id: 1, mode: 0, status: 'pending', dependencies: null }),
          makeAttack({ id: 2, mode: 3, status: 'running', dependencies: [1] }),
          makeAttack({ id: 3, mode: 0, status: 'completed', dependencies: [1, 2] }),
        ]}
      />
    )

    const edges = Array.from(screen.getByTestId('dag-edges').querySelectorAll('li')).map(
      (el) => `${el.getAttribute('data-edge-source')}->${el.getAttribute('data-edge-target')}`
    )

    expect(edges).toContain('1->2')
    expect(edges).toContain('1->3')
    expect(edges).toContain('2->3')
    expect(edges).toHaveLength(3)
  })

  it('omits edges that reference a non-existent attack', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[makeAttack({ id: 1, mode: 0, status: 'pending', dependencies: [999] })]}
      />
    )

    const edges = screen.getByTestId('dag-edges').querySelectorAll('li')
    expect(edges).toHaveLength(0)
  })

  it('applies status-aware background color to each node', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[
          makeAttack({ id: 1, mode: 0, status: 'pending', dependencies: null }),
          makeAttack({ id: 2, mode: 0, status: 'running', dependencies: null }),
          makeAttack({ id: 3, mode: 0, status: 'completed', dependencies: null }),
          makeAttack({ id: 4, mode: 0, status: 'failed', dependencies: null }),
        ]}
      />
    )

    const items = Array.from(screen.getByTestId('dag-nodes').querySelectorAll('li'))
    const bgs = items.map((el) => el.getAttribute('data-node-bg'))
    // Each rendered node should carry a non-empty background hint from its status.
    expect(bgs.every((bg) => bg && bg.length > 0)).toBe(true)
    // running/completed/failed should each render a distinct tone vs pending.
    const distinct = new Set(bgs)
    expect(distinct.size).toBeGreaterThanOrEqual(4)
  })

  it('renders node labels including attack id and mode', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[makeAttack({ id: 42, mode: 3, status: 'pending', dependencies: null })]}
      />
    )

    expect(screen.getByText(/Attack #42/)).toBeDefined()
    expect(screen.getByText(/mode 3/)).toBeDefined()
  })

  it('still renders all nodes when the dependency graph contains a cycle', () => {
    // Two nodes that depend on each other — no root exists. The
    // iterative-relaxation depth assignment must fall back to synthetic
    // depths instead of dropping nodes or hanging.
    renderWithProviders(
      <CampaignDagView
        attacks={[
          makeAttack({ id: 1, mode: 0, status: 'pending', dependencies: [2] }),
          makeAttack({ id: 2, mode: 0, status: 'pending', dependencies: [1] }),
        ]}
      />
    )

    const nodes = screen.getByTestId('dag-nodes').querySelectorAll('li')
    expect(nodes).toHaveLength(2)
  })

  it('renders an orphan that depends on a non-existent attack id', () => {
    // Orphan + valid root in the same graph. Should not hang the safety
    // counter or drop the orphan.
    renderWithProviders(
      <CampaignDagView
        attacks={[
          makeAttack({ id: 1, mode: 0, status: 'pending', dependencies: null }),
          makeAttack({ id: 2, mode: 0, status: 'pending', dependencies: [999] }),
        ]}
      />
    )

    const nodes = screen.getByTestId('dag-nodes').querySelectorAll('li')
    expect(nodes).toHaveLength(2)
  })
})
