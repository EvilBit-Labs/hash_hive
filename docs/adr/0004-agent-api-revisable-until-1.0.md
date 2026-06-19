# ADR-0004: The agent API stays revisable until 1.0

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)

## Context

`AGENTS.md` and [ADR-0001](0001-agent-enrollment-two-token-exchange.md) treat
the agent API (`/api/v1/agent/*`) as a frozen contract — "never break this
surface." That guidance assumes a stable, independently-shipped consumer. In
reality HashHive is pre-1.0 and the Go hashcat agent is being rebuilt in
lockstep with the server; there is no released agent that depends on the
current wire shapes. Treating the contract as immutable now imposes premature
cost: the PR #245 review surfaced cleaner designs for the new `/enroll`
endpoint (error model, concurrency handling) that a strict freeze would have
discouraged, and the owner confirmed the agent API is not, in fact, restricted
from change at this stage.

## Decision

Until HashHive reaches 1.0, the agent API may be revised — including
breaking changes — whenever a change is justified, provided it is coordinated
with the agent implementation and the route-as-spec contract
(`/api/v1/agent/openapi.json`) is updated in the same change. The "never
break the agent API" stability guarantee in `AGENTS.md` takes effect at 1.0;
a follow-up ADR will define the post-1.0 stability and versioning policy.

## Alternatives Considered

### Alternative 1: Keep the agent API frozen now (status quo)

- **Pros**: maximum stability; no coordination burden; honors the existing
  `AGENTS.md` rule literally.
- **Cons**: freezes design mistakes before any consumer is stable; blocks
  correctness and clarity improvements; the agent is co-developed, so the
  "external consumer" the freeze protects does not yet exist.
- **Why not**: premature rigidity — the cost of an early wrong contract that
  can't be fixed outweighs the stability benefit pre-1.0.

### Alternative 2: Introduce endpoint versioning (v1/v2) from day one

- **Pros**: lets the contract evolve without breaking older agents.
- **Cons**: heavy machinery (parallel route trees, deprecation windows) for a
  single, co-developed consumer that is not yet released.
- **Why not**: YAGNI before 1.0. Versioning is the right tool *after* the
  contract stabilizes, not while it is still being shaped.

### Alternative 3: Never commit to agent-API stability

- **Pros**: maximum freedom indefinitely.
- **Why not**: agents are the primary API consumer and operators need a
  durable contract eventually. 1.0 is the natural line where stability is
  promised.

## Consequences

### Positive

- Design mistakes in the agent contract can be corrected before they ossify
  (e.g. the `/enroll` error and conflict model).
- Server and agent evolve together pre-1.0 without parallel-version overhead.
- The route-as-spec `openapi.json` remains the single source of truth, and
  agent-API changes are made deliberately rather than avoided.

### Negative

- The server and the agent must be released/coordinated together pre-1.0; an
  out-of-date agent may break against a newer server.
- Reviewers can no longer treat any agent-API diff as an automatic blocker —
  judgement is required.

### Risks

- "Revisable" could be misread as license for churn. Mitigation: each
  agent-API change must be justified, reflected in the generated
  `openapi.json`, and coordinated with the agent repo; gratuitous breakage is
  still a smell. The dashboard/control surfaces are unaffected by this ADR.
- The 1.0 stability guarantee is deferred to a future ADR; until that exists,
  "freeze at 1.0" is an intent, not yet a defined policy. Supersede or extend
  this ADR when that policy is written.
