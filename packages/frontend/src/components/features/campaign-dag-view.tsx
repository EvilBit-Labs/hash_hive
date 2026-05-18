import { useMemo } from 'react';
import ReactFlow, { Background, type Edge, type Node, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import { EmptyState } from '../ui/empty-state';

interface AttackInput {
  id: number;
  mode: number;
  status: string;
  dependencies: number[] | null;
}

interface CampaignDagViewProps {
  attacks: ReadonlyArray<AttackInput>;
  /** Pixel height of the container. */
  height?: number;
}

/**
 * Map an attack's status to a Tailwind-token-aware background color the
 * reactflow node renderer can apply as an inline style. Reactflow nodes
 * use inline `style` rather than className for visual customization
 * because the default node uses inline rules that would otherwise win.
 */
const STATUS_COLORS: Record<string, { background: string; border: string; text: string }> = {
  pending: {
    background: 'hsl(var(--surface-1))',
    border: 'hsl(var(--surface-0))',
    text: 'hsl(var(--muted-foreground))',
  },
  running: {
    background: 'hsl(var(--info) / 0.15)',
    border: 'hsl(var(--info) / 0.4)',
    text: 'hsl(var(--info))',
  },
  assigned: {
    background: 'hsl(var(--info) / 0.15)',
    border: 'hsl(var(--info) / 0.4)',
    text: 'hsl(var(--info))',
  },
  completed: {
    background: 'hsl(var(--success) / 0.15)',
    border: 'hsl(var(--success) / 0.4)',
    text: 'hsl(var(--success))',
  },
  exhausted: {
    background: 'hsl(var(--success) / 0.15)',
    border: 'hsl(var(--success) / 0.4)',
    text: 'hsl(var(--success))',
  },
  failed: {
    background: 'hsl(var(--destructive) / 0.15)',
    border: 'hsl(var(--destructive) / 0.4)',
    text: 'hsl(var(--destructive))',
  },
};

const DEFAULT_COLORS = STATUS_COLORS['pending'] ?? {
  background: '#1f2937',
  border: '#374151',
  text: '#9ca3af',
};

const NODE_WIDTH = 160;
const NODE_HEIGHT = 56;
const H_GAP = 200;
const V_GAP = 96;

/**
 * Compute a depth per attack via iterative relaxation: roots start at 0;
 * each pass sets a node's depth to max(dep depths) + 1 once all its
 * deps are resolved. The safety counter bounds the loop in case the
 * dependency graph contains a cycle. Unreachable nodes (cycles, deps
 * outside the campaign) get a synthetic fallback depth so they still
 * render somewhere visible.
 */
function computeDepths(attacks: ReadonlyArray<AttackInput>): Map<number, number> {
  const depths = new Map<number, number>();
  const idSet = new Set(attacks.map((a) => a.id));

  for (const a of attacks) {
    const deps = (a.dependencies ?? []).filter((d) => idSet.has(d));
    if (deps.length === 0) depths.set(a.id, 0);
  }

  let changed = true;
  let safety = attacks.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const a of attacks) {
      if (depths.has(a.id)) continue;
      const deps = (a.dependencies ?? []).filter((d) => idSet.has(d));
      if (deps.every((d) => depths.has(d))) {
        const depth = Math.max(...deps.map((d) => depths.get(d) ?? 0)) + 1;
        depths.set(a.id, depth);
        changed = true;
      }
    }
  }

  // Anything still unresolved (cycles, orphans) gets a synthetic depth
  // that starts after the deepest resolved node so the fallback nodes
  // don't visually collide with real depth-0 roots.
  let maxResolvedDepth = -1;
  for (const d of depths.values()) {
    if (d > maxResolvedDepth) maxResolvedDepth = d;
  }
  const fallbackOrigin = maxResolvedDepth + 1;
  let fallbackOffset = 0;
  const unresolved: number[] = [];
  for (const a of attacks) {
    if (!depths.has(a.id)) {
      depths.set(a.id, fallbackOrigin + fallbackOffset);
      fallbackOffset += 1;
      unresolved.push(a.id);
    }
  }
  if (unresolved.length > 0) {
    // biome-ignore lint/suspicious/noConsole: protocol drift signal — surface possible cycle / orphan deps
    console.warn(
      '[CampaignDagView] depth resolution fell back for attack ids; possible cycle or orphan dependency',
      { unresolved }
    );
  }

  return depths;
}

function buildGraph(attacks: ReadonlyArray<AttackInput>): { nodes: Node[]; edges: Edge[] } {
  const depths = computeDepths(attacks);

  // Bucket nodes by depth so we can spread them horizontally per row.
  const byDepth = new Map<number, AttackInput[]>();
  for (const a of attacks) {
    const d = depths.get(a.id) ?? 0;
    const bucket = byDepth.get(d);
    if (bucket) bucket.push(a);
    else byDepth.set(d, [a]);
  }

  const nodes: Node[] = [];
  for (const [depth, rowAttacks] of byDepth.entries()) {
    rowAttacks.forEach((attack, i) => {
      const colors = STATUS_COLORS[attack.status] ?? DEFAULT_COLORS;
      nodes.push({
        id: String(attack.id),
        position: { x: i * H_GAP, y: depth * V_GAP },
        data: { label: `Attack #${attack.id} · mode ${attack.mode}` },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          background: colors.background,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          color: colors.text,
          fontSize: 12,
          fontFamily: 'inherit',
          padding: 8,
        },
        // Read-only: disable interactions per-node.
        draggable: false,
        selectable: false,
        connectable: false,
      });
    });
  }

  const idSet = new Set(attacks.map((a) => a.id));
  const edges: Edge[] = [];
  for (const attack of attacks) {
    for (const depId of attack.dependencies ?? []) {
      if (!idSet.has(depId)) continue;
      edges.push({
        id: `${depId}->${attack.id}`,
        source: String(depId),
        target: String(attack.id),
        animated: attack.status === 'running' || attack.status === 'assigned',
        style: { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1.5 },
      });
    }
  }

  return { nodes, edges };
}

export function CampaignDagView({ attacks, height = 320 }: CampaignDagViewProps) {
  const { nodes, edges } = useMemo(() => buildGraph(attacks), [attacks]);

  if (attacks.length === 0) {
    return <EmptyState message="No attacks configured." />;
  }

  return (
    <div
      data-testid="campaign-dag-view"
      style={{ height }}
      className="overflow-hidden rounded-md border border-surface-0 bg-surface-0/20"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="hsl(var(--surface-1))" />
      </ReactFlow>
    </div>
  );
}
