---
module: packages/frontend
date: 2026-05-19
problem_type: convention
component: tooling
severity: medium
tags:
  - react-hook-form
  - zod
  - forms
  - wire-shape
  - silent-data-loss
applies_when:
  - "Building a POST/PATCH payload from a React Hook Form + Zod resolver output"
  - "Conditionally spreading optional fields into a request body"
  - "A field's valid value space includes a falsy value (0, '', {}, false, NaN)"
---

# Use explicit null/undefined checks in form submit payloads

## Context

A campaign-create wizard built on React Hook Form + Zod was reviewed across
three independent passes (ce-code-review, CodeRabbit, Copilot). Each pass
flagged the same anti-pattern in a different field of the same submit
handler:

- `data.hashTypeId ? { hashTypeId: data.hashTypeId } : {}` — would silently
  drop `hashTypeId = 0` if the DB ever admitted a zero-valued serial id, and
  would drop `NaN` if a future resolver coerce failure produced one.
- `data.advancedConfiguration ? { advancedConfiguration: ... } : {}` — the
  resolver returns `undefined` for an empty textarea and the parsed object
  otherwise. An explicit `{}` object is truthy in JS so today's check
  worked by accident; a future change that makes the resolver return `{}`
  for "no keys yet" would silently drop the field.
- `hashListId: wizard.hashListId ?? 0` — a sentinel-0 path that reliably
  produces a backend `400` if `hashListId` ever becomes null (deep-link,
  store corruption, future step-navigation change). The "valid" check
  exists on the form but is bypassed by direct store access at submit time.

All three are the same shape: using JavaScript falsy/truthy semantics for
fields whose **valid value space includes a falsy value**.

## Guidance

When building a submit payload from a resolver-typed value, do not use
truthy spread guards. Choose the check based on what `undefined` means
for that field:

| Resolver returns | Use | Why |
|---|---|---|
| `T \| undefined` (field omitted) | `data.x !== undefined ? { x: data.x } : {}` | Preserves valid falsy values (`0`, `false`, `''`, `{}`) |
| `T \| null \| undefined` (nullable) | `data.x != null ? { x: data.x } : {}` | Loose equality rejects both null and undefined; tolerates accidental `NaN` |
| `T` (always present, never falsy) | `{ x: data.x }` unconditionally, or `data.x ? ... : {}` is fine | No risk |

For values that come from outside the resolver (store fields, defaults),
do **not** invent a sentinel value to satisfy the schema. Preflight-check
and surface a user error:

```ts
// WRONG: silently sends a sentinel the backend will reject
const result = await createCampaign.mutateAsync({
  hashListId: wizard.hashListId ?? 0,
  ...
});

// RIGHT: refuse to submit; surface the error to the user
if (wizard.hashListId == null) {
  setError('Select a hash list before creating the campaign.');
  return;
}
const result = await createCampaign.mutateAsync({
  hashListId: wizard.hashListId,
  ...
});
```

## Why This Matters

- **Silent data loss.** The user filled in a valid value; the wizard
  silently drops it; the backend stores a record missing that field. No
  error message, no banner, no log. Bugs of this shape are filed as "the
  feature doesn't work" weeks later.
- **Defense in depth.** Backend Zod schemas already enforce the wire
  contract, but relying on the backend to reject a sentinel ID hides the
  real failure (state corruption, missing UI guard) behind a generic 400.
  The frontend should refuse to send an invalid payload in the first
  place.
- **Resolver coercion failure modes.** When the form uses
  `z.coerce.number()`, an invalid coerce produces `NaN`, not `undefined`.
  Truthy checks drop `NaN`; `!= null` does not. The `!= null` form
  preserves the bug as a backend validation error the user can see.

## When to Apply

- Every conditional spread that builds a request body from form data.
- Every place a store field with a nullable type is used as a required
  request body field — preflight, don't sentinel.
- When reviewing PRs that touch form submit handlers, look for the
  `data.x ? { x: data.x } : {}` shape and flag it.

## Examples

### Before (anti-pattern across 5 different fields)

```ts
// packages/frontend/src/pages/campaign-create.tsx — original
const payload = {
  mode: data.mode,
  ...(data.hashTypeId ? { hashTypeId: data.hashTypeId } : {}),       // drops 0, NaN
  ...(data.wordlistId ? { wordlistId: data.wordlistId } : {}),       // OK (positive int)
  ...(data.advancedConfiguration                                      // drops {}
    ? { advancedConfiguration: data.advancedConfiguration }
    : {}),
};

const result = await createCampaign.mutateAsync({
  name: wizard.name,
  hashListId: wizard.hashListId ?? 0,                                 // sends invalid sentinel
  ...
});
```

### After (each guard matches its field's value space)

```ts
const payload = {
  mode: data.mode,
  ...(data.hashTypeId != null ? { hashTypeId: data.hashTypeId } : {}),
  ...(data.wordlistId ? { wordlistId: data.wordlistId } : {}),       // positive int — fine
  ...(data.advancedConfiguration !== undefined
    ? { advancedConfiguration: data.advancedConfiguration }
    : {}),
};

// Preflight before submit — no sentinels
if (wizard.hashListId == null) {
  setError('Select a hash list before creating the campaign.');
  return;
}
const result = await createCampaign.mutateAsync({
  name: wizard.name,
  hashListId: wizard.hashListId,
  ...
});
```

### Test that guards the preflight

```ts
it('refuses to POST when hashListId is null (no `?? 0` sentinel)', async () => {
  useCampaignWizard.setState({ step: 2, hashListId: null, attacks: [...] });

  let campaignPostCount = 0;
  // ...mock fetch, count POSTs to /dashboard/campaigns...

  renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
  fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));

  await waitFor(() => {
    expect(screen.getByText(/Select a hash list/)).toBeDefined();
  });
  expect(campaignPostCount).toBe(0);
});
```

## References

- PR #149 — three commits incrementally fixed each manifestation of this
  anti-pattern in `packages/frontend/src/pages/campaign-create.tsx`
  (`handleSubmit` and `handleAttackSubmit`).
- Related: `GOTCHAS.md` notes on `z.preprocess` + RHF resolver casts.
