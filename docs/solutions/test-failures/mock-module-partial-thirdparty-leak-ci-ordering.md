---
title: "A partial mock.module() of a third-party package leaks process-wide and breaks another file's import under CI file ordering"
date: 2026-07-17
category: docs/solutions/test-failures
module: packages/frontend/tests
problem_type: test_failure
component: testing_framework
symptoms:
  - "just ci-check green locally (macOS) but the ci-check job red on GitHub (Linux), in the unit phase before e2e"
  - "An entire unrelated test file failed uniformly (every test, sub-20ms) with SyntaxError: Export named 'Position' not found in module '.../reactflow/dist/esm/index.mjs'"
  - "The failing file (CampaignDetailPage) never changed; the leak was exposed only because new test files shifted the CI file-discovery order"
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags:
  - bun-test
  - mock-module
  - test-isolation
  - ci-file-ordering
  - reactflow
  - esm
  - linux-vs-macos
---

# A partial mock.module() of a third-party package leaks process-wide and breaks another file's import under CI file ordering

## Problem

`bun test` runs every file in `tests/` in one process. A `mock.module('reactflow', ...)` registered by one test file replaces that entry in the module cache for the **rest of the process**, not just its own file. When the mock returns a **partial** export set (only what the mocking file's own component needs), and CI's file ordering runs that file **before** another file whose system-under-test statically `import { Position } from 'reactflow'`, the later import resolves against the leaked partial mock, `Position` isn't there, and Bun throws `SyntaxError: Export named 'Position' not found` at link time — taking down the whole later test file.

## Symptoms

- `just check` and `just ci-check` pass locally; GitHub CI's `ci-check` fails in the unit phase.
- One whole test file (`campaign-detail.test.tsx`) fails uniformly — every test, all with tiny durations — which signals a module-load/link error, not assertion failures.
- The error names a symbol (`Position`) that the *failing* file's component imports but that the file's own test never mentions.
- The failure appeared only after this branch **added new frontend test files**, which changed Bun's file-discovery order on Linux enough to run the incomplete-mock file first.

## What Didn't Work

- **Assuming it was the local edit that touched the file.** The last change to `campaign-create.tsx` (a `<div role="status">` → `<output>` a11y fix) looked suspect, but reverting it wouldn't have helped — the panel-render logic was untouched and the error was a link-time import failure, not a render/assertion failure.
- **Reading it as flaky/timing.** The uniform sub-20ms failures across a whole file looked like they *might* be an async race, but a race produces mixed pass/fail, not a whole file failing identically. The `SyntaxError` in the raw log (buried under many passing tests that log expected errors) was the real signal — grep for `(fail)` markers and `SyntaxError`, not for the word `error`.
- **Trusting a green local `just ci-check`.** Local (macOS) file ordering happened to run the *complete* mock (`campaign-dag-view.test.tsx`, which includes `Position`) in a way that masked the leak. The bug is order-dependent, so only CI's ordering exposed it.

## Solution

Make the mock **complete enough that leaking it can't break any co-running file's import**: add every export that any component sharing the process statically imports. `campaign-dag-view.tsx` imports `{ Background, Position }`; `campaign-dag-view.test.tsx`'s mock already had `Position`, but `campaign-create.test.tsx`'s did not.

```ts
// packages/frontend/tests/pages/campaign-create.test.tsx
mock.module('reactflow', () => {
  // ...ReactFlow stub, Background, Controls, useNodesState, useEdgesState...
  return {
    default: ReactFlow,
    Background: () => null,
    Controls: () => null,
    // `Position` must be present even though CampaignCreatePage doesn't use it:
    // bun's mock.module persists process-wide, so under CI's file ordering this
    // mock can be the active `reactflow` when a later test (campaign-detail,
    // which renders campaign-dag-view) statically imports `{ Position }`.
    // Omitting it makes that import fail at link time. Mirrors campaign-dag-view.test.tsx.
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState,
    useEdgesState,
  }
})
```

Verify against the CI order locally by running the *incomplete-mock* file **before** the victim file in one invocation:

```bash
bun test --preload ./tests/setup.ts \
  tests/pages/campaign-create.test.tsx \
  tests/pages/campaign-detail.test.tsx   # 55 pass, 0 fail with Position added
```

## Why This Works

`mock.module()` mutates a process-global module cache entry; there is no per-file teardown by default, so the last registration for a module name wins for every subsequent static import in the process. A static `import { X }` is resolved/linked eagerly, so if the active (mocked) module object lacks `X`, it's a hard `SyntaxError` at link time — not a runtime `undefined`. Whether that happens depends on which mocking file registered last, i.e. on file order, which differs between macOS (local) and Linux (CI). Providing every symbol any co-running SUT imports means the leaked mock is a superset and no import can fail — removing the order dependency.

## Prevention

- **When you `mock.module()` a shared third-party package, mock the union of exports every co-running component imports — not just your file's needs.** Grep the source for `from '<pkg>'` value imports (types are erased) across the components any sibling test renders, and include all of them. For `reactflow` that means at least `default`, `Background`, `Controls`, `Position`, `useNodesState`, `useEdgesState`.
- **Or isolate the file** so its mock can't leak: the isolated-phase env-gate pattern (see [`conventions/bun-test-mock-module-import-order.md`](../conventions/bun-test-mock-module-import-order.md), Pattern B) runs the file in its own bun-test process, which also contains the leak.
- **A whole-file uniform failure with tiny per-test durations is a module-load/link error, not assertions.** In a noisy CI log (many passing tests print expected errors), grep for `(fail)` and `SyntaxError`/`Export named`, not the word `error`.
- **Green local `just ci-check` is not proof for order-dependent test isolation.** These bugs are Linux-vs-macOS file-ordering-sensitive; `just ci-check` runs the same phases but not the same file order. When a change adds test files, treat a green local run as necessary-not-sufficient and let CI confirm.

## Related

- [`conventions/bun-test-mock-module-import-order.md`](../conventions/bun-test-mock-module-import-order.md) — the sibling `mock.module()` trap (mock registered *after* the import, so it's a silent no-op) and the two resolution patterns (mutable-impl vars; isolated-phase env gate). This doc is the *cross-file leak + incomplete export set* variant; that doc is the *ordering-within-a-file* variant. `GOTCHAS.md` covers the underlying `mock.module()` mechanics.
- [`test-failures/playwright-shared-seed-user-last-project-id-flake.md`](./playwright-shared-seed-user-last-project-id-flake.md) and [`test-failures/getbytext-collision-waitfor-timeout.md`](./getbytext-collision-waitfor-timeout.md) — other cases where shared/leaked test state surfaced as a confusing, non-obvious failure.
