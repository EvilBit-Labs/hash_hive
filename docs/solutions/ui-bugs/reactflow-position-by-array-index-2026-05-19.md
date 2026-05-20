---
module: packages/frontend
date: 2026-05-19
problem_type: ui_bug
component: tooling
severity: medium
symptoms:
  - "Nodes jump to incorrect positions after removing a node from the array"
  - "User-dragged layout is silently overwritten when array state changes"
  - "Positions appear correct on add but get reassigned to the wrong node on remove"
root_cause: logic_error
resolution_type: code_fix
tags:
  - reactflow
  - graph-ui
  - array-index-keys
  - position-preservation
  - silent-misassignment
---

# React Flow node positions silently misassigned when keyed by array index

## Problem

A React Flow editor backed by a Zustand-managed array of items (one node per
array entry) preserved user-dragged positions by keying them on the React
Flow `node.id` value. The node id was `String(arrayIndex)`. The sync
effect rebuilt nodes whenever the array changed and "preserved" positions
by looking them up in a `Map<id, position>` built from the previous render.

This worked correctly for **add** and **update** operations because they do
not shift indices. It broke silently on **remove**: when the user removed
the attack at index 1, every subsequent index shifted down by one. The
position previously stored for `id="2"` was now applied to whatever attack
had moved into slot 2 (formerly slot 3). Visually, the remaining nodes
"jumped" into the wrong places, and the user-dragged layout was effectively
randomized after every removal.

## Symptoms

- Removing any attack except the last one caused remaining nodes to appear
  in unexpected positions.
- The misassignment was consistent (same input → same output) but appeared
  random because the user had no model of which index used to be where.
- No error in the console; no test failure (the test fixture rendered with
  default grid positions and never exercised drag → remove).

## What Didn't Work

- **Initial fix attempt: do nothing.** The first PR included the
  position-preservation effect but no test for the remove path. The bug
  shipped and was caught only by the Copilot reviewer on PR #149, not by
  manual QA (the wizard's primary flow doesn't exercise drag-then-remove
  immediately).
- **"Just don't preserve positions"** — would correctly fix the
  misassignment, but the UX cost is high: every drag is wiped on every
  store change including updates and adds. Rejected in favor of the
  partial preservation below.

## Solution

Track the previous array length in a `useRef`. On length **decrease**
(== a remove happened), reset positions to the grid layout. On length
unchanged (== update) or increase (== add), the index keys are stable and
position preservation is safe.

```ts
const prevAttacksLengthRef = useRef(wizard.attacks.length);

useEffect(() => {
  const prevLen = prevAttacksLengthRef.current;
  const newLen = wizard.attacks.length;
  prevAttacksLengthRef.current = newLen;

  setNodes((prev) => {
    if (newLen < prevLen) {
      // remove: indices shifted; per-index positions no longer correspond
      // to the same attack. Reset to grid layout.
      return buildNodes(wizard.attacks);
    }
    // add or update: preserve existing positions
    const prevPositions = new Map(prev.map((n) => [n.id, n.position]));
    return buildNodes(wizard.attacks).map((n) => {
      const previous = prevPositions.get(n.id);
      return previous ? { ...n, position: previous } : n;
    });
  });
  setEdges(buildEdges(wizard.attacks));
}, [wizard.attacks, setNodes, setEdges]);
```

## Why This Works

Index-based keys are stable iff the array operation preserves index→item
identity. Three operations to consider:

| Operation | Length change | Index stability | Position map valid? |
|---|---|---|---|
| `addAttack` (append) | +1 | Existing 0..N-1 unchanged; new N appears | Yes — preserve all |
| `updateAttack(i, ...)` | 0 | Identity unchanged at every index | Yes — preserve all |
| `removeAttack(i)` | -1 | Indices > i shift down by one | **No** — every position above i now points to a different item |

Detecting length decrease is a 100% correct proxy for "removeAttack
happened" given the store's API surface. There is no public operation
that decreases length without shifting indices, so this is safe.

## When To Apply

Any time a graph/list visualization layer keys per-item state on something
derived from array position rather than item identity:

- React Flow node positions, when nodes correspond to array entries
- D3 force-layout positions
- DnD-kit reorder state with index-keyed metadata
- Virtualized list scroll positions if the list reorders

Anywhere the data layer can shift indices without renaming the array
position to the same item, **either** prove the operations preserve
identity-at-index, **or** invalidate per-index state on the operation
that breaks the invariant.

## Prevention

1. **Prefer a stable per-item `uiId`** when the array can reorder for
   any reason. Generate via `crypto.randomUUID()` at add time, persist on
   the in-memory item (wizard-local; never sent over the wire). Then the
   position map keys never go stale regardless of array operations. This
   is the textbook fix; the trade-off is plumbing a wizard-only field
   through the store, the type, and the submit-path body builder.

2. **If the array operations are constrained enough**, use the
   length-decrease detection above. It is correct for append + update +
   remove-only and requires no schema changes. Document the assumption in
   the effect comment so a future reorder/move feature surfaces the
   invariant break loudly.

3. **Test the remove path explicitly.** Render with 2+ items, simulate a
   remove, and assert positions/labels match the expected items. The
   original PR shipped without this test, which is why the bug was caught
   by code review and not CI.

4. **Reviewers: flag any per-array-index Map** in a graph/list layer
   without an obvious answer to "what happens when an item is removed?"
   The shape is the smell, even if the current operations happen to be
   safe today.

## References

- PR #149 commit `c9a88f8` — the fix applied to the campaign creation
  wizard's React Flow integration.
- Copilot review comment that surfaced the bug: noted the misassignment
  shape and suggested either dropping preservation on index-shifting
  operations OR introducing a stable per-attack UI id.
- Related: `packages/frontend/src/pages/campaign-create.tsx` sync effect
  in `CampaignCreatePage`.
