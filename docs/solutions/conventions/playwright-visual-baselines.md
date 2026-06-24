---
module: packages/frontend/e2e, .github/workflows
date: 2026-06-23
status: active
problem_type: convention
component: e2e-testing
severity: medium
applies_when:
  - "Adding or updating a Playwright visual-regression baseline (toHaveScreenshot)"
  - "A visual baseline test diffs in CI with no intentional UI change"
  - "Changing the CI runner image for a job that validates a committed baseline"
  - "Reviewing a PR that commits a *-snapshots PNG"
tags:
  - playwright
  - visual-regression
  - e2e
  - ci
  - snapshots
  - github-actions
  - fonts
---

# Playwright visual baselines

How HashHive generates, commits, and maintains Playwright screenshot baselines
(`toHaveScreenshot`). The first baseline is the dashboard at 1440×900
(`packages/frontend/e2e/zz-dashboard.spec.ts`); this convention governs every
one added after it.

## Linux CI is the only canonical platform

A screenshot baseline is a frozen PNG compared pixel-for-pixel against future
runs. Font metrics, subpixel antialiasing, and emoji rasterisation differ
between operating systems, so a baseline is only valid on the platform that
generated it.

- **Baselines are generated on a GitHub Linux runner and committed with
  Playwright's `-chromium-linux` platform suffix** (e.g.
  `dashboard-1440x900-chromium-linux.png`).
- **Never commit a baseline generated on macOS or Windows.** A local macOS run
  *will* report a platform/pixel mismatch — that message is expected behaviour,
  not a regression. Do not run `--update-snapshots` locally to silence it.

## Pin the runner image — never `ubuntu-latest`

The committed PNG is frozen, but `ubuntu-latest` is a rolling alias GitHub
migrates across major OS versions (20.04 → 22.04 → 24.04). Each migration
updates freetype, fontconfig, and the system font stack — the exact inputs the
baseline depends on (the app ships no bundled web fonts; all text rendering uses
runner-provided system fonts). An alias migration would make every baseline
self-diff on an unrelated PR with no code to blame.

- Both the **generation** workflow (`.github/workflows/regenerate-visual-baselines.yml`)
  and the **validation** job (`e2e-tests` in `.github/workflows/ci.yml`) pin the
  **same dated image** (`ubuntu-24.04`). Keep them in lockstep.
- When GitHub deprecates the pinned image, bump *both* jobs together and
  regenerate the baseline in the same PR.

## How to generate or update a baseline (intentionally)

Generation runs on CI because only the GitHub runner matches the validating
environment. The `regenerate-visual-baselines.yml` workflow does it and uploads
the PNG as an artifact — it never commits.

1. **Trigger generation.**
   - On a branch / for a brand-new baseline: open the PR and add the
     `regen-baselines` label (a same-repo PR runs the workflow from the PR head
     branch, so this works before the workflow is on `main`).
   - For steady-state updates once the workflow is on `main`: run it via
     `workflow_dispatch` (`gh workflow run regenerate-visual-baselines.yml`).
2. **Download the artifact:** `gh run download <run-id> -n visual-baselines`
   into `packages/frontend/e2e/<spec>-snapshots/`. Sanity-check the PNG is
   non-trivial (> 50 KB) and carries the `-chromium-linux` suffix.
3. **Commit the PNG and the unskip together** in one commit, so the first CI run
   of the unskipped test already has the baseline present (no red window). The
   generation workflow ephemerally unskips the test in the CI workspace only
   (`--update-snapshots` does not run a `test.skip` test) — that change is never
   committed; you commit the real unskip.
4. **Remove the `regen-baselines` label** so generation does not re-fire on
   every subsequent push.
5. **Verify CI twice:** the validation run passes (R3), and a no-op re-run also
   passes (the baseline matches itself). The re-run is the real determinism
   gate — see below.

## Tolerance and determinism

- **Tolerance is `maxDiffPixelRatio: 0.02`** (~2% of pixel area). Raise it only
  with written justification in the PR. Prefer stabilising or masking
  non-deterministic regions over inflating tolerance.
- **Stabilise non-deterministic state at its source, then mask the remainder.**
  Masking cannot fix a *conditional mount* — a region that sometimes doesn't
  exist can't be masked, and its appearance reflows the layout. The dashboard
  baseline drives the page to the `Live` (open) connection state before
  capturing, which unmounts the conditional `FreshnessLine` ("Last updated X
  ago", a 1 Hz wall-clock ticker) and fixes the connection-indicator label
  width. The `output[aria-label]` mask is then belt-and-suspenders over residual
  status pixels. **Masked regions render as magenta boxes in the committed PNG —
  expected, not corruption.**

  > Connection-state stabilisation approach (dashboard baseline): **wait for the
  > `Live` state** (`output[aria-label="Live"]`). The e2e backend connects
  > reliably, so the WebSocket reaches `open` within the test timeout. If a
  > future surface cannot reliably connect, fall back to forcing
  > `ConnectionIndicator`'s documented `status` prop via a test hook.
- **Capture Motion-driven UI under `prefers-reduced-motion: reduce`.**
  `animations: 'disabled'` only fast-forwards CSS animations/transitions — it
  does not freeze `motion/react` (JS/rAF/WAAPI) motion. `emulateMedia({
  reducedMotion: 'reduce' })` resolves it to a deterministic end state.
- **Scope `retries: 0` to visual tests** (the e2e config defaults to `retries:
  2` in CI) so a no-op re-run is a strict idempotency check rather than a
  3-attempts-allowed one.

## Design-change updates

When the UI changes intentionally, regenerate the baseline on Linux (steps
above) and include a before/after screenshot in the PR description so reviewers
can confirm the new baseline is the intended appearance.
