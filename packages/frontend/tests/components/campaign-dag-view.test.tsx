import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanupAll, renderWithProviders, screen } from '../test-utils';

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
    nodes: Array<{ id: string; data: { label: string }; style?: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; target: string }>;
  }) {
    return (
      <div data-testid="react-flow-stub">
        <ul data-testid="dag-nodes">
          {nodes.map((n) => (
            <li key={n.id} data-node-id={n.id} data-node-bg={String(n.style?.['background'] ?? '')}>
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
    );
  }
  return {
    default: ReactFlow,
    Background: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  };
});

// Stub reactflow's CSS import — happy-dom's CSS loader does not handle
// the module's stylesheet.
mock.module('reactflow/dist/style.css', () => ({}));

// Import AFTER mocks so the stub flows through.
const { CampaignDagView } = await import('../../src/components/features/campaign-dag-view');

afterEach(cleanupAll);

describe('CampaignDagView', () => {
  it('renders an empty state when no attacks are configured', () => {
    renderWithProviders(<CampaignDagView attacks={[]} />);
    expect(screen.getByText('No attacks configured.')).toBeDefined();
  });

  it('renders one node per attack', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[
          { id: 1, mode: 0, status: 'pending', dependencies: null },
          { id: 2, mode: 3, status: 'running', dependencies: [1] },
          { id: 3, mode: 0, status: 'completed', dependencies: [2] },
        ]}
      />
    );

    const items = screen.getByTestId('dag-nodes').querySelectorAll('li');
    expect(items).toHaveLength(3);
  });

  it('renders an edge for each dependency reference', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[
          { id: 1, mode: 0, status: 'pending', dependencies: null },
          { id: 2, mode: 3, status: 'running', dependencies: [1] },
          { id: 3, mode: 0, status: 'completed', dependencies: [1, 2] },
        ]}
      />
    );

    const edges = Array.from(screen.getByTestId('dag-edges').querySelectorAll('li')).map(
      (el) => `${el.getAttribute('data-edge-source')}->${el.getAttribute('data-edge-target')}`
    );

    expect(edges).toContain('1->2');
    expect(edges).toContain('1->3');
    expect(edges).toContain('2->3');
    expect(edges).toHaveLength(3);
  });

  it('omits edges that reference a non-existent attack', () => {
    renderWithProviders(
      <CampaignDagView attacks={[{ id: 1, mode: 0, status: 'pending', dependencies: [999] }]} />
    );

    const edges = screen.getByTestId('dag-edges').querySelectorAll('li');
    expect(edges).toHaveLength(0);
  });

  it('applies status-aware background color to each node', () => {
    renderWithProviders(
      <CampaignDagView
        attacks={[
          { id: 1, mode: 0, status: 'pending', dependencies: null },
          { id: 2, mode: 0, status: 'running', dependencies: null },
          { id: 3, mode: 0, status: 'completed', dependencies: null },
          { id: 4, mode: 0, status: 'failed', dependencies: null },
        ]}
      />
    );

    const items = Array.from(screen.getByTestId('dag-nodes').querySelectorAll('li'));
    const bgs = items.map((el) => el.getAttribute('data-node-bg'));
    // Each rendered node should carry a non-empty background hint from its status.
    expect(bgs.every((bg) => bg && bg.length > 0)).toBe(true);
    // running/completed/failed should each render a distinct tone vs pending.
    const distinct = new Set(bgs);
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });

  it('renders node labels including attack id and mode', () => {
    renderWithProviders(
      <CampaignDagView attacks={[{ id: 42, mode: 3, status: 'pending', dependencies: null }]} />
    );

    expect(screen.getByText(/Attack #42/)).toBeDefined();
    expect(screen.getByText(/mode 3/)).toBeDefined();
  });
});
