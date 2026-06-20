---
title: getByText collisions across components surface as waitFor timeouts, not "multiple elements" errors
date: 2026-06-18
category: docs/solutions/test-failures
module: packages/frontend
problem_type: test_failure
component: testing_framework
symptoms:
  - "Adding a new component to a shared page broke unrelated DashboardPage tests with ~1000ms waitFor timeouts, not a clear assertion error"
  - "screen.getByText('3 / 5') matched two elements once a second component rendered the same text"
  - "Tests that performed no extra fetches (keyboard-nav) failed identically, so the cause looked async but wasn't"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
tags: [frontend-testing, testing-library, getbytext, waitfor, react, text-collision]
---

# getByText collisions across components surface as waitFor timeouts, not "multiple elements" errors

## Problem

Mounting a new `FirstRunChecklist` on the dashboard broke 8 unrelated `DashboardPage` tests. The checklist rendered a progress count `"3 / 5"` and bare step-number markers (`"2"`, `"3"`, …), which collided with the agents stat card's `online / total` value (`"3 / 5"`) and other bare stat values (`"2"`, `"10"`, `"42"`). React Testing Library's `getByText` searches the whole document, so those queries became ambiguous.

## Symptoms

- `DashboardPage` tests failed with **~1000ms `waitFor` timeouts**, not an obvious error.
- `screen.getByText('3 / 5')` (the agents card) now matched two elements.
- Even tests that did no fetching (keyboard-nav, card-click) failed, so it *looked* like an async/hang problem.

## What Didn't Work

- **Assuming the new component's extra data fetches were hanging the page.** The checklist fires three resource queries; the dashboard tests don't mock those endpoints. But `createTestQueryClient` sets `retry: false`, so the unmatched-route 404s resolve immediately — they were not the cause.
- **Looking for a thrown "multiple elements found" error.** There wasn't one in the output. The ambiguous `getByText` ran *inside* `waitFor`, which swallows the throw and retries until the timeout — so a text-collision presents as a generic ~1000ms timeout, masking the real cause.

## Solution

Make the new component's strings distinct so no global `getByText` is ambiguous:

```tsx
// Before — "3 / 5" collides with the agents card's "online / total"
<span>{doneCount} / {steps.length}</span>
// After
<span>{doneCount} of {steps.length} done</span>

// Before — bare step number "2" collides with a stat value of "2"
{done ? <Check /> : index + 1}
// After — a ring/check marker, no bare digit
{done ? <Check /> : null}
```

The collided dashboard tests (`getByText('3 / 5')`, `getByText('2')`) then resolved cleanly.

## Why This Works

`getByText` matches against the text content of the *entire* rendered document, not a scoped subtree. Two components emitting the same string is genuinely ambiguous, and RTL throws on ambiguity. Because the ambiguous query sat inside `waitFor`, the throw was retried rather than reported, so it manifested as a timeout. Removing the duplicate text removes the ambiguity at the source.

## Prevention

- **Avoid emitting generic, collision-prone text** (`"N / M"`, bare numbers, single words) from a component you add to an already-tested page. Distinct copy (`"N of 5 done"`) is cheap insurance.
- **Prefer scoped or role/test-id queries** in tests: `within(section).getByText(...)`, `getByRole`, or `getByTestId`, so a new component elsewhere on the page can't make an existing query ambiguous.
- **Heuristic for debugging:** when a `waitFor` starts timing out right after you added UI — and the assertion is a `getByText` — suspect a text collision (ambiguous match retried to timeout), not an async/data problem. Reproduce by calling the bare `getByText` outside `waitFor` to see the real "multiple elements" error.

## Related Issues

- #233 — onboarding first-run journey (the work that introduced the checklist).
