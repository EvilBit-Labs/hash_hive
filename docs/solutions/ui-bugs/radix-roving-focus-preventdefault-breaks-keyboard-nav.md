---
module: packages/frontend/src/components/ui/segmented-control.tsx
date: 2026-06-29
problem_type: ui_bug
component: frontend_ui_primitives
severity: medium
symptoms:
  - "Arrow-key focus movement stops working after preventDefault is added to a custom keyboard handler over a Radix roving-focus component"
  - "Playwright e2e assertion `expect(el).toBeFocused()` fails after an arrow key despite onChange/selection firing correctly"
  - "Selection commits (value updates) but focus does not advance to the next item"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - radix-ui
  - roving-focus
  - keyboard-navigation
  - compose-event-handlers
  - segmented-control
  - a11y
  - capture-phase
---

# Radix roving-focus: a capture-phase preventDefault silently disables keyboard nav

## Problem

`SegmentedControl` wraps Radix `ToggleGroup` (`type="single"`, `loop`) and adds a capture-phase `onKeyDownCapture` handler to restore WAI-ARIA radio behavior: arrow keys should move **both** focus and the committed selection simultaneously. Radix's roving-tabindex moves focus on its own; the custom handler calls `onChange` for the same key events so the two stay aligned.

A reviewer correctly noted that arrow keys can scroll the page and flagged the handler as missing `event.preventDefault()`. Adding `preventDefault()` looked harmless - the unit suite stayed green, `just check` passed - but it silently broke arrow-key focus movement. Selection advanced; focus did not.

## Symptoms

- After `page.keyboard.press('ArrowRight')` in Playwright, `await expect(cracked).toBeFocused()` failed with "unexpected value: inactive". The item became checked (selection moved) but focus remained on the previously-focused item.
- `just check` (format + lint + type-check + build) was green. Unit tests were green. Only `just ci-check` (the full e2e suite) surfaced the regression.
- The regression slipped in because the commit adding `preventDefault()` was validated only against `just check` and the unit suite, not the full e2e.

## What Didn't Work

**(a) Adding `event.preventDefault()` in the capture handler.** This is what introduced the regression. See root cause below.

**(b) Replacing `ToggleGroup` with Radix `RadioGroup`.** An earlier attempt to get native arrow-to-select behavior by swapping to `RadioGroup` also failed: `RadioGroup` does not auto-commit selection on arrow under Playwright's synthetic key events. Its `onFocus`-selects-on-arrow path depends on an internal "arrow-key-was-pressed" flag that Playwright's fast synthetic `keydown`/`keyup` race defeats. This approach was reverted and the `ToggleGroup` + capture-handler design was kept.

## Solution

Remove `event.preventDefault()` from the capture handler. Radix owns scroll suppression; the custom handler's only job is to call `onChange` to commit the selection. A prominent comment in the code warns future maintainers not to re-add it.

Before (the broken version):

```ts
const handleArrowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
  const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const isPrev = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  if (!isNext && !isPrev) return
  event.preventDefault() // <-- this line silently disabled Radix's roving focus
  const currentIndex = options.findIndex((option) => option.value === value)
  // ...
  if (next) onChange(next.value)
}
```

After (the fixed version, from `packages/frontend/src/components/ui/segmented-control.tsx`):

```ts
const handleArrowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
  const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const isPrev = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  if (!isNext && !isPrev) return
  // Do NOT preventDefault here. Radix's RovingFocusGroup moves focus and
  // already suppresses the arrow's default scroll, but its item handler is
  // composed with checkForDefaultPrevented - so calling preventDefault in
  // this capture-phase handler would make Radix skip the focus move, leaving
  // selection and focus out of sync.
  const currentIndex = options.findIndex((option) => option.value === value)
  if (currentIndex === -1) {
    if (import.meta.env.DEV) {
      // oxlint-disable-next-line no-console
      console.warn(`SegmentedControl: value "${value}" does not match any option`)
    }
    return
  }
  const delta = isNext ? 1 : -1
  const next = options[(currentIndex + delta + options.length) % options.length]
  if (next) onChange(next.value)
}
```

## Why This Works

Radix `RovingFocusGroup` composes each item's `onKeyDown` using `composeEventHandlers(userOnKeyDown, radixOnKeyDown)`. The second argument accepts a `checkForDefaultPrevented` option that defaults to `true`: when it is `true`, the library skips its own handler if `event.defaultPrevented` is already set.

The capture-phase `onKeyDownCapture` handler fires before any item handler. Calling `event.preventDefault()` there sets `event.defaultPrevented = true`. By the time Radix's roving focus handler runs via `composeEventHandlers`, `checkForDefaultPrevented` causes it to be skipped entirely - so the focus move never happens. Separately, Radix's roving implementation already calls `preventDefault()` for the four arrow keys it handles (orientation is unset, so all four are active), so manual scroll suppression was redundant from the start.

With `preventDefault` removed, the capture handler commits the selection via `onChange`, Radix rerenders with the new `value` and moves roving focus to the now-selected item, and both mechanisms land on the same item without any coordination beyond not setting `defaultPrevented` early.

## Prevention

When layering a custom keyboard handler over any Radix roving-focus primitive (`ToggleGroup`, `Tabs`, `RadioGroup`, `Toolbar`, `Select`), do **not** call `event.preventDefault()` in a handler that fires before Radix's item handler - that includes capture-phase handlers and parent-element handlers. `composeEventHandlers` checks `event.defaultPrevented` by default, and setting it early silently swallows Radix's own handler, disabling roving focus and keyboard navigation with no visible error. Let Radix own `preventDefault` for the keys it handles; the custom handler should only **add** behavior (here: committing the selection via `onChange`).

Test both focus movement and the state change after a key press - asserting only one is insufficient to catch this class of bug. From `packages/frontend/e2e/zz-radix-primitives.spec.ts`:

```ts
// Restored radio pattern: ArrowRight moves focus AND commits selection to
// the next segment (a capture-phase keydown handler over Radix's roving).
await all.focus()
await page.keyboard.press('ArrowRight')
await expect(cracked).toBeFocused() // focus moved
await expect(cracked).toBeChecked() // selection committed
await expect(all).not.toBeChecked()
```

Both assertions are required. A test that only checked `toBeChecked()` would have passed even with the broken `preventDefault()` version, because selection still moved - only focus did not.

Finally, always run the full e2e suite (`just ci-check`) when touching keyboard handlers on Radix components. The unit suite (bun:test + happy-dom) cannot drive Playwright synthetic key events through Radix's real DOM event composition; `just check` + unit alone is not sufficient validation for this class of change.

## Related

- [`docs/solutions/conventions/shadcn-radix-non-destructive-add-on-tailwind-v4.md`](../conventions/shadcn-radix-non-destructive-add-on-tailwind-v4.md) - the shadcn/Radix migration conventions doc. It already notes that happy-dom cannot drive roving-tabindex arrow-key nav (route those to Playwright); this doc explains the deeper `composeEventHandlers` / `preventDefault` causal mechanism, which also breaks in a real browser, not just happy-dom.
