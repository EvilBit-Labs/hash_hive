import { describe, expect, it } from 'bun:test'

import { topologicalOrder, validateDAG } from '../../src/lib/dag-validation'

describe('validateDAG', () => {
  it('should return valid for empty attacks array', () => {
    expect(validateDAG([])).toEqual({ valid: true })
  })

  it('should return valid for a single attack with no dependencies', () => {
    expect(validateDAG([{ dependencies: [] }])).toEqual({ valid: true })
  })

  it('should return valid for parallel attacks (no dependencies)', () => {
    const attacks = [{ dependencies: [] }, { dependencies: [] }, { dependencies: [] }]
    expect(validateDAG(attacks)).toEqual({ valid: true })
  })

  it('should return valid for a linear chain (0 → 1 → 2)', () => {
    const attacks = [{ dependencies: [] }, { dependencies: [0] }, { dependencies: [1] }]
    expect(validateDAG(attacks)).toEqual({ valid: true })
  })

  it('should return valid for diamond DAG (0 → 1, 0 → 2, 1 → 3, 2 → 3)', () => {
    const attacks = [
      { dependencies: [] },
      { dependencies: [0] },
      { dependencies: [0] },
      { dependencies: [1, 2] },
    ]
    expect(validateDAG(attacks)).toEqual({ valid: true })
  })

  it('should detect simple cycle (0 → 1 → 0)', () => {
    const attacks = [{ dependencies: [1] }, { dependencies: [0] }]
    const result = validateDAG(attacks)
    expect(result.valid).toBe(false)
    expect(result.cycle).toBeDefined()
    expect(result.cycle?.sort()).toEqual([0, 1])
  })

  it('should detect complex cycle (0 → 1 → 2 → 0)', () => {
    const attacks = [{ dependencies: [2] }, { dependencies: [0] }, { dependencies: [1] }]
    const result = validateDAG(attacks)
    expect(result.valid).toBe(false)
    expect(result.cycle).toBeDefined()
    expect(result.cycle?.sort()).toEqual([0, 1, 2])
  })

  it('should detect cycle in subset (0 ok, 1 → 2 → 1)', () => {
    const attacks = [{ dependencies: [] }, { dependencies: [2] }, { dependencies: [1] }]
    const result = validateDAG(attacks)
    expect(result.valid).toBe(false)
    expect(result.cycle).toBeDefined()
    expect(result.cycle?.sort()).toEqual([1, 2])
  })

  it('should ignore out-of-range dependency indices', () => {
    const attacks = [{ dependencies: [99] }, { dependencies: [] }]
    expect(validateDAG(attacks)).toEqual({ valid: true })
  })

  it('should handle self-dependency as a cycle', () => {
    const attacks = [{ dependencies: [0] }]
    const result = validateDAG(attacks)
    expect(result.valid).toBe(false)
    expect(result.cycle).toEqual([0])
  })

  it('should silently skip out-of-range dependency indices but still return a useful result', () => {
    // attack #0 references a non-existent index 99 — buildGraph drops
    // the edge rather than throw. validation still passes because the
    // remaining graph has no cycle.
    const result = validateDAG([{ dependencies: [99] }, { dependencies: [] }])
    expect(result.valid).toBe(true)
  })
})

describe('topologicalOrder', () => {
  it('returns ok:true with [] for an empty input', () => {
    const result = topologicalOrder([])
    expect(result).toEqual({ ok: true, order: [] })
  })

  it('returns the only index for a single attack with no dependencies', () => {
    const result = topologicalOrder([{ dependencies: [] }])
    expect(result).toEqual({ ok: true, order: [0] })
  })

  it('returns the indices in dependency order for a linear chain 0-1-2', () => {
    // attack 0 has no deps; attack 1 depends on 0; attack 2 depends on 1
    const result = topologicalOrder([
      { dependencies: [] },
      { dependencies: [0] },
      { dependencies: [1] },
    ])
    expect(result).toEqual({ ok: true, order: [0, 1, 2] })
  })

  it('returns a valid order for a diamond (0->1, 0->2, 1->3, 2->3)', () => {
    const attacks = [
      { dependencies: [] }, // 0
      { dependencies: [0] }, // 1
      { dependencies: [0] }, // 2
      { dependencies: [1, 2] }, // 3
    ]
    const result = topologicalOrder(attacks)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order).toHaveLength(4)
    // 0 must precede 1, 2, 3; 1 and 2 must precede 3
    const pos = new Map(result.order.map((idx, i) => [idx, i]))
    expect(pos.get(0)).toBeLessThan(pos.get(1) ?? -1)
    expect(pos.get(0)).toBeLessThan(pos.get(2) ?? -1)
    expect(pos.get(1)).toBeLessThan(pos.get(3) ?? -1)
    expect(pos.get(2)).toBeLessThan(pos.get(3) ?? -1)
  })

  it('returns ok:false with the cycle when the graph contains a cycle', () => {
    // 0 <-> 1
    const result = topologicalOrder([{ dependencies: [1] }, { dependencies: [0] }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.cycle.sort((a, b) => a - b)).toEqual([0, 1])
  })

  it('returns ok:false with the cycle for a self-dependency', () => {
    const result = topologicalOrder([{ dependencies: [0] }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.cycle).toEqual([0])
  })
})
