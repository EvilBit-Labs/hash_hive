# Residual Review Findings — feat/campaign-wizard-completion

Source: `ce-code-review mode:autofix` run `20260518-221332-eec5700a`
(artifact: `/tmp/compound-engineering/ce-code-review/20260518-221332-eec5700a/`)

These findings were flagged by the multi-agent code review for the Campaign
Creation Wizard completion. The `safe_auto` class (7 items) was applied in
the same PR as the feature work. The items below could not be auto-applied
either because they require architectural decisions, test refactors,
backend coordination, or because they exceed the scope of a single-pass
mechanical fix. Each one is real and was independently corroborated by at
least one reviewer; none were fabricated.

## Residual Review Findings

- **[P1][packages/frontend/src/pages/campaign-create.tsx handleSubmit]
  Partial-creation orphan on mid-submit failure (REL-002 / adv-1 / JFR-003).**
  When `createCampaign` succeeds but a later attack POST fails, the wizard
  shows the error string but leaves an orphan campaign with partial
  attacks in the DB. No rollback, no retry affordance. Cancel-during-submit
  hits the same race. Needs a compensating DELETE or a navigate-to-detail
  affordance with a "retry failed attacks" flow.

- **[P1][packages/frontend/src/lib/api.ts:22] `fetch()` has no timeout
  (REL-001, pre-existing).** All API calls hang indefinitely on backend
  slowness; combined with the sequential attack-creation loop this can
  hold connections open until the tab is closed. Add
  `signal: AbortSignal.timeout(30_000)` to `request()`. Pre-existing — not
  introduced by this PR, but discovered during review.

- **[P1][packages/frontend/src/pages/campaign-create.tsx:169-172] React
  Flow drag positions wiped by attacks-change sync effect (JFR-001).** The
  effect calls `setNodes(buildNodes(...))` on every `wizard.attacks`
  change, snapping nodes back to the grid layout and discarding any
  positions the user dragged. Needs a position-preserving merge inside the
  effect (~10 lines).

- **[P1][packages/frontend/src/pages/campaign-create.tsx:174-177] Strict
  Mode double-mount fires `wizard.reset()` (JFR-002).** In dev Strict Mode
  the cleanup-on-unmount runs during the discard mount and wipes
  pre-seeded wizard state. The obvious fix (reset-on-mount) was attempted
  during autofix and reverted because the existing test pattern seeds
  state in `beforeEach` and depends on persistence across mount. Fix
  requires either a mounted-ref guard on the cleanup or a test-pattern
  refactor.

- **[P2][packages/frontend/src/stores/campaign-wizard.ts +
  packages/frontend/src/pages/campaign-create.tsx] AttackConfig +
  AttackForm should derive from `@hashhive/shared CreateAttackRequest`
  (AC-001).** Now that the shared `createAttackRequestSchema` includes
  `advancedConfiguration` (applied in this PR), these local interfaces
  should be replaced with `z.infer<typeof createAttackRequestSchema>` per
  the AGENTS.md wire-shape rule.

- **[P2][packages/frontend/src/pages/campaign-create.tsx]
  `advancedConfiguration` form-type mismatch (KT-001 / KT-002 / adv-8).**
  RHF stores the textarea value as a `string`; the resolver transforms on
  submit. `AttackForm.advancedConfiguration: Record<string, unknown>` is a
  type lie — `getValues('advancedConfiguration')` returns a string at
  runtime but is typed as a Record. Fix: widen the form type to
  `string | Record<string, unknown> | undefined` and let the resolver
  narrow at submit time.

- **[P2][packages/frontend/src/pages/campaign-create.tsx:200-204]
  Hash-type prefill overrides manual choice on background refetch
  (JFR-005).** If `useHashLists` refetches and returns a different
  `hashTypeId`, the effect's `setValue` overwrites the user's manual
  selection. Fix: track touched state via `formState.dirtyFields` or a
  one-shot ref so prefill only runs while the field is untouched.

- **[P2][packages/frontend/src/pages/campaign-create.tsx] File is 943
  lines, project ceiling 800 (M001).** Three distinct responsibilities —
  attack form, attack list, DAG editor — could be extracted into separate
  sub-components. Mechanical refactor; deferred to keep this PR focused.

- **[P2][packages/frontend/src/pages/campaign-create.tsx]
  `advancedConfigSchema` and `optionalResourceId` defined inline (M004).**
  Should move to `packages/frontend/src/lib/attack-schemas.ts` alongside
  `attack-modes.ts` so future forms reusing JSON-config or
  optional-resource patterns can import them.

- **[P2][packages/backend/src/routes/control/resources.ts] Hash types not
  enumerable via Control API (agent-native W1, pre-existing).** Control
  API exposes `/resources/{wordlists, rulelists, masklists}` but not
  `/hash-types`. An automation client cannot look up valid `hashTypeId`
  values without calling the cookie-authenticated Dashboard API. Add
  `GET /api/v1/control/resources/hash-types`.

- **[P3][packages/frontend/tests/pages/campaign-create.test.tsx] Test
  coverage gaps (T-001..T-006).** Missing scenarios: mid-loop submit
  failure (partial-creation orphan), advancedConfiguration edit
  round-trip, hash-type prefill suppression during edit,
  edit-preserves-original-dependencies, Step 0 form rehydration on Back,
  advancedConfigSchema rejection branches (array / null / primitive),
  diamond DAG submit remapping.
