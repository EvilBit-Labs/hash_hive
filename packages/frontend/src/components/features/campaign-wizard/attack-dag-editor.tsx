import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type OnConnect,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { attackModeLabel } from '../../../lib/attack-modes';
import type { AttackConfig } from '../../../stores/campaign-wizard';
import { ErrorBanner } from '../../ui/error-banner';

/** Catppuccin red - matches --ctp-red / --destructive token. */
const CYCLE_EDGE_COLOR = 'hsl(351, 74%, 73%)';

interface AttackDagEditorProps {
  attacks: readonly AttackConfig[];
  nodes: FlowNode[];
  edges: Edge[];
  cycle: number[] | undefined;
  isValid: boolean;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: OnConnect;
  onEdgesDelete: (edges: Edge[]) => void;
  onNodeClick: (event: unknown, node: { id: string }) => void;
  onNodeContextMenu: (event: { preventDefault: () => void }, node: { id: string }) => void;
}

/**
 * React Flow surface for the wizard's dependency graph. Renders a
 * cycle-error banner with attack labels when the DAG is invalid, and
 * highlights cycle-participating edges in red so the user can see which
 * edges to delete.
 */
export function AttackDagEditor({
  attacks,
  nodes,
  edges,
  cycle,
  isValid,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onEdgesDelete,
  onNodeClick,
  onNodeContextMenu,
}: AttackDagEditorProps) {
  const cycleLabels = cycle
    ?.map((i) => {
      const attack = attacks[i];
      return attack ? `#${i} ${attackModeLabel(attack.mode)}` : `#${i}`;
    })
    .join(', ');

  const styledEdges = isValid
    ? edges
    : edges.map((e) => {
        const sourceIdx = Number(e.source);
        const targetIdx = Number(e.target);
        const inCycle = cycle?.includes(sourceIdx) && cycle?.includes(targetIdx);
        return inCycle ? { ...e, style: { stroke: CYCLE_EDGE_COLOR, strokeWidth: 2 } } : e;
      });

  return (
    <div className="w-3/5 space-y-2">
      <h3 className="text-sm font-medium">Dependency Graph</h3>
      <p className="text-xs text-muted-foreground">
        Drag edges between attacks to set dependencies. Arrow from A -&gt; B means B depends on A.
      </p>
      {!isValid && (
        <ErrorBanner
          message={`Circular dependency detected between attacks: [${cycleLabels}]`}
          className="text-xs"
        />
      )}
      <div className="h-[400px] rounded-md border border-surface-0 bg-crust">
        {attacks.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={styledEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            fitView
            deleteKeyCode="Backspace"
          >
            <Background />
            <Controls />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Add attacks to see the dependency graph
          </div>
        )}
      </div>
    </div>
  );
}
