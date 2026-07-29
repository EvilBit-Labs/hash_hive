---
title: BetterAuth client crashes at module load when window.location.origin is null/opaque
date: 2026-07-28
category: test-failures
module: packages/frontend/src/lib/auth-client.ts
problem_type: test_failure
component: authentication
symptoms:
  - "BetterAuthError: Invalid base URL: null. Please provide a valid base URL."
  - "TypeError: \"null\" cannot be parsed as a URL."
  - Many frontend test files fail to load at once (reported as N fail + N errors) with no change to their own code
  - "ci-check green locally but red in CI (Linux happy-dom), or vice versa"
root_cause: config_error
resolution_type: code_fix
severity: high
tags:
  - better-auth
  - happy-dom
  - window-location-origin
  - module-load
  - opaque-origin
  - frontend-testing
---

# BetterAuth client crashes at module load when window.location.origin is null/opaque

## Problem
`auth-client.ts` constructed the BetterAuth client at module scope with `baseURL: window.location.origin`. When `origin` is `null`/`"null"` (opaque origins, or the Linux happy-dom test DOM), BetterAuth validates the base URL eagerly and throws **at import time**, so every module that transitively imports the client — the whole app, and 8 component test files — fails to link. It blocked the mandatory `ci-check` gate.

## Symptoms
- `BetterAuthError: Invalid base URL: null. Please provide a valid base URL.` and `TypeError: "null" cannot be parsed as a URL.`
- A cluster of unrelated frontend test files fail together with "N fail / N errors" even though none of their own code changed.
- Passes locally (a valid `window.location.origin`) but fails in CI on Linux happy-dom — or the reverse, depending on the runner's DOM.

## What Didn't Work
- Re-running the CI job — the failure is deterministic (an environment property, not a flake), so a re-run reproduced it identically.
- Treating it as a regression from the feature under review — the failing tests (and an unrelated `AgentDetailPage` case) do not touch the auth client; `git diff` showed the branch's only nearby change was query-key additions. Chasing the feature diff wasted time.

## Solution
Resolve the base URL through a helper that tolerates an absent/opaque origin, instead of passing `window.location.origin` straight into `createAuthClient` at module load:

```ts
// Before — throws at import when origin is null/"null":
export const authClient = createAuthClient({ baseURL: window.location.origin })

// After — never throws at import; real http(s) pages are unaffected:
function resolveAuthBaseUrl(): string {
  const origin = typeof window !== 'undefined' ? window.location?.origin : undefined
  return origin && origin !== 'null' ? origin : 'http://localhost'
}
export const authClient = createAuthClient({ baseURL: resolveAuthBaseUrl() })
```

The happy-dom test setup (`packages/frontend/tests/setup.ts`) creates the window with `new Window({ url: 'http://localhost:3000' })`, but Linux happy-dom v20 can still surface `origin` as `null` for that URL — the same class of OS-specific gap the setup file already documents for `ResizeObserver`/SVG globals.

## Why This Works
`window.location.origin` is legitimately `"null"` for opaque origins (sandboxed iframes, `file://`, `data:`) and can be `null` under happy-dom. Because the client is a module-scope singleton, an eager throw during its construction propagates to every importer's link step — turning one bad value into a mass module-load failure. Falling back to a syntactically valid `http://localhost` keeps construction total; a real browser served over http/https always has a usable origin, so the fallback only ever applies in degenerate environments where auth calls are mocked anyway. Behavior in production is unchanged.

## Prevention
- Never feed a value that can be `null`/opaque (`window.location.origin`, `document.referrer`, `import.meta.env.*`) directly into an eagerly-validating constructor that runs at **module scope** — normalize it through a total helper with a valid fallback first.
- When a batch of unrelated test files fail to *load* together (not assert), suspect a shared module-scope side effect (a client/singleton constructed on import), not the individual tests.
- Local-green / CI-red (or the reverse) on DOM-touching code points at an environment difference (happy-dom version, OS, origin) rather than a flake — reproduce by reasoning about the environment, don't just re-run.
- A mandatory CI gate must be green regardless of whether the failure predates your branch; confirm scope with `git diff main..HEAD` and fix the environment-robustness gap rather than documenting around it.

## Related Issues
- `packages/frontend/tests/setup.ts` — documents the parallel Linux happy-dom v20 gap for `ResizeObserver`/`IntersectionObserver`/SVG globals injected onto `globalThis`.
- Sibling repair in the same fix: an over-strict `getByText('RTX 4090')` in `agent-detail.test.tsx` changed to `getAllByText` (the GPU model renders in two components by design).
