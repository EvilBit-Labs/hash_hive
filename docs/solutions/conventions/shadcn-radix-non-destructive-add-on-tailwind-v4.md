---
module: packages/frontend/src/components/ui, packages/frontend/src/index.css
date: 2026-06-27
problem_type: convention
component: frontend_ui_primitives
severity: high
related_components:
  - tailwind_v4
  - testing_framework
applies_when:
  - "Adding or updating a shadcn/ui primitive in packages/frontend/src/components/ui/"
  - "Running the shadcn CLI against the frontend package"
  - "Writing tests for Radix-backed components under bun:test + happy-dom"
  - "Editing packages/frontend/src/index.css"
tags:
  - shadcn
  - radix
  - tailwind-v4
  - catppuccin
  - happy-dom
---

# shadcn/ui on Tailwind v4 + Catppuccin: non-destructive `add`-only workflow

The `ui/` primitives are real shadcn/ui components backed by Radix (unified
`radix-ui` package + `class-variance-authority` + `tw-animate-css`). They were
migrated from hand-rolled lookalikes. Follow these rules so the next change
doesn't silently break the theme or re-hand-roll a primitive.

## Never run `shadcn init` against this tree

`shadcn init` **rewrites `src/index.css`** (upstream shadcn-ui/ui #2791). That
file's line 5 — `@config '../tailwind.config.ts';` — is the bridge that makes
Tailwind v4 read the legacy config; lose it and **every** custom color
(`bg-primary`, `border-surface-*`, `ctp-*`, `success`/`warning`/`info`) silently
renders transparent **with no build error**. `init` would also replace the
dark-only Catppuccin `:root` block with shadcn's light-`:root` + `.dark` default.

Use `shadcn add <component>` only. `components.json` is already hand-authored
(style `new-york`, `tailwind.config: ""`, `tailwind.css: "src/index.css"`,
`cssVariables: true`, literal `src/...` aliases). Adding a component writes one
file into `src/components/ui/` and installs nothing new (all Radix primitives
come from the single `radix-ui` package, already a dependency).

## Two mechanical fixups after every `shadcn add`

1. **Imports are bare specifiers.** Generated files import `from "src/lib/utils"`
   / `from "src/components/ui/x"` (from the literal-path aliases). These are
   invalid module specifiers. Every `ui/` file sits at `src/components/ui/`, so
   rewrite to relative: `from '../../lib/utils'`, `from './x'`. (Literal aliases
   are deliberate: tsconfig resolves `@/*` → `./*` while Vite resolves `@` →
   `./src`, so shadcn's default `@/` imports would break type-check.)
2. **Re-apply Catppuccin tokens.** shadcn ships neutral defaults. Re-apply the
   component's existing token classes for visual equivalence (R3) — preserve the
   public API and the look; gain Radix's a11y underneath.

## Verify the theme bridge survived (the canary)

`just check` passing is **not** proof the theme works — happy-dom and a green
build both pass on a dead theme. After any `index.css` edit, confirm a
token-driven utility still resolves: build and grep the generated CSS for
`.bg-primary{background-color:hsl(var(--primary))}` plus `--primary:21 86% 73%`,
or read `getComputedStyle(el).backgroundColor` on a `bg-primary` element in the
running app (must be peach `rgb(245,168,127)`, not `rgba(0,0,0,0)`).

## happy-dom needs `NodeFilter`/`TreeWalker` for Radix

Radix focus-scope + `aria-hidden` sibling-hiding walk the DOM via
`createTreeWalker`, which reads `NodeFilter.*` from global scope. `tests/setup.ts`
injects `NodeFilter`/`TreeWalker` (alongside ResizeObserver etc.) — without them
every open Radix overlay throws `ReferenceError: NodeFilter is not defined` at
render.

## Test behavior, not Radix internals

- Assert role / accessible-name / selection-state / keyboard-outcome, never
  Radix data-attributes or `aria-pressed` literals. Radix `ToggleGroup type=single`
  renders `role="radiogroup"` + `role="radio"` + `aria-checked` (not
  `aria-pressed`); `Tabs` renders `role="tablist"/tab/tabpanel`.
- Radix `Tabs` activates a trigger on **mousedown**, not click — drive switches
  with `fireEvent.mouseDown(tab, { button: 0 })`.
- happy-dom cannot drive roving-tabindex arrow-key nav or Radix Select/Dialog
  portal open-and-click — route those to Playwright (`e2e/`), do not fake them.
  Roving-focus arrow nav also breaks in a real browser if a custom keyboard
  handler calls `preventDefault` before Radix's — see
  [`../ui-bugs/radix-roving-focus-preventdefault-breaks-keyboard-nav.md`](../ui-bugs/radix-roving-focus-preventdefault-breaks-keyboard-nav.md).
- An open Radix Dialog sets `aria-hidden` on the background, so page controls
  leave the accessibility tree; query the dialog's own controls (they become the
  single accessible match by name).
- `@testing-library/user-event` is **not** installed — use `fireEvent`.

## Gotchas captured during the migration

- shadcn's generated `progress.tsx` destructures `value` but never re-passes it
  to `ProgressPrimitive.Root` → Radix reports indeterminate, no `aria-valuenow`.
  Pass `value` through explicitly.
- Radix Select reserves `value=""` as the uncontrolled-clear signal, so a
  `SelectItem value=""` silently clears the selection instead of setting it —
  round-trip `''` through an internal sentinel (`'__NONE__'`).
- react-hook-form `form.register()` is incompatible with Radix Select (no native
  ref/onChange) — wrap those callsites in `<Controller>`.
- `buttonVariants` keeps its **positional** signature (`buttonVariants('secondary',
  'sm')`) via a shim over the cva options-object form, so escape-hatch callsites
  on `<a>`/`<Link>` are untouched. Button has no Radix equivalent — the migration
  is the cva idiom, in place.
