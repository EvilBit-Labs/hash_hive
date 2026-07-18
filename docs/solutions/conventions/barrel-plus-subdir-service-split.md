---
title: "Barrel-plus-subdir pattern for splitting oversized service files"
date: 2026-05-30
problem_type: convention
component: service_object
severity: medium
module: packages/backend/src/services
applies_when:
  - "A service file in packages/backend/src/services passes ~800 LOC and has 2+ cohesive concerns"
  - "The service is consumed via mock.module(...) in tests OR via await import(...) from a circular-dep workaround"
  - "At least one helper is shared between the parent's surviving code and a planned submodule"
  - "Caller import paths must stay stable to avoid a wide blast radius across tests and other services"
tags:
  - backend
  - refactor
  - esm
  - barrel-export
  - file-size-budget
  - mock-module
  - circular-dependency
related_components:
  - testing_framework
  - tooling
---

# Barrel-plus-subdir pattern for splitting oversized service files

## Context

Two refactors in `packages/backend/src/services` independently hit the same constraints and converged on the same shape:

- **U7** split `services/agents.ts` by extracting `services/agents/heartbeat.ts` while keeping `services/agents.ts` in place as both the slimmed primary file and the barrel.
- **U9** split `services/tasks.ts` (1286 LOC, over the project's 800-line file-size budget) into `services/tasks/retry.ts`, `services/tasks/zaps.ts`, `services/tasks/agent-projection.ts`, plus a small `services/tasks/_internals.ts` for shared helpers -- and kept the parent at `services/tasks.ts` (751 LOC right after the split; the pattern has since accreted more submodules and the parent has grown past the budget again as new task logic landed -- a later split is warranted).

Both refactors had to preserve a fragile set of caller assumptions: seven test files mock the parent path with `mock.module('../../src/services/tasks.js', ...)`, `services/agents/heartbeat.ts` does `await import('../tasks.js')` to break a circular dep, and call sites across `routes/` and other services import the parent directly. Renaming the parent to `services/tasks/index.ts` would have silently no-op'd the mock registrations and forced churn across dozens of files. The convention below is what survives those constraints.

## Guidance

Four-part recipe:

### 1. Parent file stays at its original path

Keep `services/tasks.ts` and `services/agents.ts` where they are. Do **not** move to `services/X/index.ts`. Node and Bun resolve both shapes identically via directory-with-index resolution, but keeping the parent in place minimizes git blame churn and matches the precedent already in the codebase.

### 2. Submodules go in a sibling subdir named after the parent

```text
packages/backend/src/services/
├── tasks.ts                       # barrel + slimmed primary (751 LOC)
├── tasks/
│   ├── _internals.ts              # shared helpers, not re-exported
│   ├── agent-projection.ts        # per-agent task listing
│   ├── retry.ts                   # retry + failure handling
│   └── zaps.ts                    # zap endpoint
├── agents.ts                      # barrel + slimmed primary
└── agents/
    └── heartbeat.ts               # heartbeat ingestion (U7 precedent)
```

Each submodule owns one cohesive concern, typically 50-400 LOC.

### 3. Parent re-exports submodule symbols at the bottom

```ts
// packages/backend/src/services/tasks.ts (tail of file)

// ─── Re-exports from ./tasks/* submodules ─────────────────────────
//
// Several concerns live in their own files so this parent stays
// under the per-file size budget. Re-exporting here is the contract --
// every caller (including the lazy `await import('../tasks.js')` in
// `services/agents/heartbeat.ts`, the seven `mock.module(...)` test
// registrations against this path, and the workers + route handlers)
// resolves through `services/tasks.js` exactly as it did before the
// split. Keep this list complete; a missing symbol degrades the lazy
// import silently.
export {
  AGENT_TASK_ACTIVE_STATUSES,
  type AgentTaskActiveStatus,
  listTasksByAgent,
  projectAgentTaskRows,
} from './tasks/agent-projection.js'
export { handleTaskFailure, MAX_RETRIES, reassignStaleTasks } from './tasks/retry.js'
export { getZapsForTask } from './tasks/zaps.js'
```

Sort re-export statements alphabetically by source-file path -- enforced as a convention during PR review (`ea1029e`).

### 4. Shared internal helpers go in `services/X/_internals.ts`

When both the parent file and a submodule need the same helper, extract to `_internals.ts`. The underscore prefix marks "not re-exported by the barrel" and avoids the ESM static-import cycle that would form if the submodule imported through the parent:

```ts
// packages/backend/src/services/tasks/_internals.ts
//
// Lives here to avoid an ESM cycle. Both the parent `services/tasks.ts`
// (task generation) and sibling `services/tasks/retry.ts` (the stale-
// task rebalance) need `jsonSafeBigint`; if retry imported it from the
// parent barrel, the barrel's top-level `export ... from './tasks/retry.js'`
// would form a static import loop and module load order would become
// load-bearing.

const SAFE_NUMBER_THRESHOLD = BigInt(Number.MAX_SAFE_INTEGER)

export function jsonSafeBigint(value: bigint): number | string {
  return value <= SAFE_NUMBER_THRESHOLD ? Number(value) : value.toString()
}
```

```ts
// packages/backend/src/services/tasks/retry.ts
import { jsonSafeBigint } from './_internals.js'  // sibling, no cycle
// NOT: import { jsonSafeBigint } from '../tasks.js'  // would form a cycle
```

The U7 agents split is the first instance of this pattern in the codebase -- it only needed steps 1-3 because no helper was shared. U9 added step 4 when `jsonSafeBigint` turned out to be needed by both the parent's generation block and `retry.ts`'s sweep rebalance.

## Why This Matters

- **Barrel surface stability for `mock.module`.** Bun's `mock.module(path, ...)` binds by literal path. If the parent moves to `services/tasks/index.ts`, the seven test files registering `mock.module('../../src/services/tasks.js', ...)` resolve to a new module identity that the production code no longer imports -- the mocks silently no-op and tests pass by accident. The barrel keeps the literal path live.
- **Stable lazy-import resolution for circular-dep workarounds.** `services/agents/heartbeat.ts` uses `await import('../tasks.js')` to break a cycle with `services/tasks.ts`. Moving the parent breaks the dynamic-import path string.
- **File-size budget.** The project's 800-line/file budget is non-negotiable. Submodules are how large services stay under budget without breaking the public surface.
- **Avoids the ESM cycle trap.** A sibling submodule that imports through the parent barrel forms a hard cycle: parent re-exports from submodule, submodule imports from parent. `_internals.ts` is the escape valve -- it sits below both the parent and the submodules in the dependency graph.

## When to Apply

Apply when **all** of:

- A service file passes ~800 LOC and has at least 2-3 cohesive concerns that could each live in their own file.
- The parent file is consumed via direct import **or** via `mock.module(...)` registrations in tests **or** via `await import(...)` from a circular-dep workaround.
- At least one helper would be needed by both the parent's surviving code and one of the new submodules. (If not, skip step 4 -- `_internals.ts` is not speculative infrastructure.)

Do **not** apply when:

- The file is already under budget after smaller cleanups. The dashboard route files came under budget after the `scopedUser` + `dashboardError` codemods landed -- no split was needed and forcing one would have added indirection for no gain.
- Only one concern would be extracted. A flat sibling pair like `services/agents.ts` + `services/agents/heartbeat.ts` is fine; you don't need the full `_internals.ts` infrastructure for one extraction.

## Examples

**U9: `services/tasks.ts` split (1286 LOC → 751 LOC parent + 4 submodules)**

Atomic commits on `refactor/tasks-service-split` (PR #181):

- `bb4162c` -- extract task retry & failure to `services/tasks/retry.ts`
- `a7c8a72` -- extract per-agent task listing to `services/tasks/agent-projection.ts`
- `fb77ee4` -- extract zap endpoint to `services/tasks/zaps.ts`
- `ea1029e` -- alphabetize re-export statements by source file

Tree right after the U9 split (`_internals` + three extracted submodules, parent as barrel at tail):

```text
packages/backend/src/services/
├── tasks.ts                              # barrel at tail
└── tasks/
    ├── _internals.ts                     # jsonSafeBigint
    ├── agent-projection.ts               # listTasksByAgent + projectAgentTaskRows
    ├── retry.ts                          # handleTaskFailure + reassignStaleTasks + MAX_RETRIES
    └── zaps.ts                           # getZapsForTask
```

The pattern kept accreting the same way as more task logic landed: `services/tasks/` has since gained `preemption.ts`, `task-events.ts`, `task-resources.ts`, and `zap-cursor.ts`. Each extraction followed the identical barrel-plus-subdir shape without touching caller imports -- the point of the convention.

Caller code unchanged across the refactor:

```ts
// packages/backend/src/routes/dashboard/tasks.ts -- unchanged
import { getTaskById, listTasks } from '../../services/tasks.js'

// packages/backend/src/routes/agent/index.ts -- unchanged
import { handleTaskFailure, getZapsForTask } from '../../services/tasks.js'
```

Test mocks unchanged:

```ts
// packages/backend/tests/unit/dashboard-tasks-routes.test.ts -- still binds
mock.module('../../src/services/tasks.js', () => ({
  handleTaskFailure: mock(() => Promise.resolve()),
  // ...all the symbols the production import chain pulls through the barrel
}))
```

## Related

- `docs/solutions/conventions/bun-test-mock-module-import-order.md` -- why `mock.module` path identity matters and how Bun resolves it. This convention exists in part to preserve the path identity that doc depends on.
- The project's 800-line file-size budget -- drives when this pattern applies.
- `GOTCHAS.md` -- Service Layer entry covers the lazy `await import(...)` cycle workaround that this convention preserves.
