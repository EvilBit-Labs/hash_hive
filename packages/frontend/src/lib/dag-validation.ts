interface AttackNode {
  dependencies: number[];
}

interface ValidationResult {
  valid: boolean;
  cycle?: number[];
}

/**
 * Discriminated union covering both topological-sort outcomes:
 * - `ok: true` carries the order, every dependency precedes its dependent.
 * - `ok: false` carries the cycle participants by index.
 *
 * Used by `topologicalOrder` so callers don't have to call `validateDAG`
 * separately to surface a useful error when a cycle is present.
 */
export type TopoResult = { ok: true; order: number[] } | { ok: false; cycle: number[] };

/**
 * Builds an index-based in-degree map and adjacency list for the attack
 * dependency graph. Shared by `validateDAG` and `topologicalOrder` so cycle
 * detection and topological sort cannot diverge on edge cases (out-of-range
 * indices, missing entries) the way two parallel implementations could.
 *
 * Out-of-range dependency indices are silently skipped: the wizard's
 * `removeAttack` already rewrites the dependency list, so any stale index
 * we see here is a structural bug elsewhere — we choose to keep the graph
 * walk well-defined rather than throw deep inside a layout helper.
 */
function buildGraph(attacks: readonly AttackNode[]): {
  inDegree: Map<number, number>;
  adjacency: Map<number, number[]>;
} {
  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();

  for (let i = 0; i < attacks.length; i++) {
    inDegree.set(i, 0);
    adjacency.set(i, []);
  }

  for (let i = 0; i < attacks.length; i++) {
    const attack = attacks[i];
    if (!attack) continue;
    for (const depIdx of attack.dependencies) {
      if (depIdx < 0 || depIdx >= attacks.length) {
        // Stale index — the store's removeAttack shift logic should have
        // rewritten this. In dev, surface the structural bug loudly so the
        // root cause gets fixed rather than masked by graceful degradation.
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only structural bug surface
          console.warn(
            `dag-validation: attack #${i} references missing dep #${depIdx} (total ${attacks.length})`
          );
        }
        continue;
      }
      adjacency.get(depIdx)?.push(i);
      inDegree.set(i, (inDegree.get(i) ?? 0) + 1);
    }
  }

  return { inDegree, adjacency };
}

/**
 * Validates that attacks form a valid DAG (no circular dependencies).
 * Uses Kahn's topological sort algorithm, matching the backend implementation
 * in packages/backend/src/services/campaigns.ts.
 *
 * Dependencies are index-based: attack.dependencies contains indices of
 * attacks that must complete before this attack can run.
 * An edge from dependency -> dependent means "dependency must finish first."
 */
export function validateDAG(attacks: readonly AttackNode[]): ValidationResult {
  if (attacks.length === 0) {
    return { valid: true };
  }

  const { inDegree, adjacency } = buildGraph(attacks);

  // Kahn's algorithm
  const queue: number[] = [];
  for (const [idx, degree] of inDegree) {
    if (degree === 0) {
      queue.push(idx);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    processed++;

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processed !== attacks.length) {
    // Collect indices of nodes still in the graph (cycle participants)
    const cycle: number[] = [];
    for (const [idx, degree] of inDegree) {
      if (degree > 0) {
        cycle.push(idx);
      }
    }
    return { valid: false, cycle };
  }

  return { valid: true };
}

/**
 * Returns attack indices in a valid topological order (every dependency
 * precedes its dependent), or the cycle participants when the graph
 * contains a cycle. Carries the cycle in the failure shape so callers
 * don't have to call `validateDAG` separately for a useful error.
 *
 * Used by the create-campaign submit path to issue per-attack POSTs in an
 * order that guarantees each attack's dependency IDs are already known
 * before the dependent attack is created.
 */
export function topologicalOrder(attacks: readonly AttackNode[]): TopoResult {
  if (attacks.length === 0) return { ok: true, order: [] };

  const { inDegree, adjacency } = buildGraph(attacks);

  const queue: number[] = [];
  for (const [idx, degree] of inDegree) {
    if (degree === 0) queue.push(idx);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    order.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (order.length === attacks.length) {
    return { ok: true, order };
  }

  const cycle: number[] = [];
  for (const [idx, degree] of inDegree) {
    if (degree > 0) cycle.push(idx);
  }
  return { ok: false, cycle };
}
