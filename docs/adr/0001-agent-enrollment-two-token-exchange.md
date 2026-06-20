# ADR-0001: Agent enrollment via two-token exchange

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)

## Context

HashHive had no way to register a new agent: agent rows were only ever
inserted by the legacy `migrate-data.ts` script, and the per-agent
bearer-token rotation endpoint requires an agent that already exists. The
dashboard onboarding even told operators to "grab a token from the agents
page," which had no such affordance. We need a mechanism for an admin to
authorize a brand-new agent on a private/air-gapped LAN (#233, #114).

## Decision

An admin mints a short, human-typeable **enrollment token**
(`etk_<id>_<word-phrase>`, project-scoped, one-time or reusable, optional
expiry, revocable). The agent presents it once to an anonymous
`POST /api/v1/agent/enroll` endpoint, which atomically validates and
consumes it and issues the agent its long-lived per-agent **bearer token**
(the existing `agt_<id>_<random>` credential). The human never types the
bearer token. Enrollment is idempotent on an agent-supplied stable
`clientId`. Both enrollment secret and bearer token are bcrypt-hashed (cost
12); the raw values are shown once and never persisted.

## Alternatives Considered

### Alternative 1: Single pre-shared bearer token typed into the agent

- **Pros**: simplest; no new endpoint or table.
- **Cons**: the 43-char base64url bearer token is not human-typeable; no
  lifecycle (expiry/revocation/usage caps); no batch enrollment.
- **Why not**: fails the "typeable, operator-friendly, revocable" goal and
  can't support bringing up a rack of rigs at once.

### Alternative 2: Fast hash (SHA-256/HMAC) for the enrollment secret

- **Pros**: cheaper verify; avoids bcrypt CPU on an unauthenticated endpoint.
- **Why not**: a *typeable* token is necessarily low-entropy (a word-phrase),
  so bcrypt's slowness is protective, not waste. The `id` routing hint means
  an unknown id triggers no hash at all, so the unauthenticated-DoS concern is
  moot. Keeping bcrypt-12 also preserves the codebase's single-hash unification.

### Alternative 3: Per-IP rate limiting on the enroll endpoint

- **Pros**: bounds brute-force/abuse on an anonymous endpoint.
- **Why not**: a reusable token's whole purpose is batch enrollment — many
  rigs behind one NAT'd egress IP — which naive per-IP limiting would throttle.
  Abuse is already bounded by atomic per-token usage caps and the cheap-reject
  (unknown id → no row → no bcrypt). If backpressure is ever needed, the
  intended shape is an optional slow-down response header, not a request limiter.

## Consequences

### Positive

- Honest first-run: the onboarding arc now lands on real affordances.
- Reuses the existing `agt_` bearer infrastructure unchanged.
- Project-scoped, revocable, expiring, usage-capped credentials with an audit
  trail (`revoked_at` timestamp, `use_count`).
- Idempotent retry: a dropped enroll response doesn't mint duplicate agents.

### Negative

- New unauthenticated endpoint that creates agents (mitigated: requires a valid
  project-scoped secret; atomic consumption caps blast radius).
- A second credential format (`etk_`) alongside `agt_`/`cst_`.

### Risks

- DB-level atomicity of the guarded consume + partial unique index is currently
  proven by reasoning + decision-logic tests, not a real-DB concurrency test;
  the planned testcontainers work will close this.
- The rebuilt Go agent must conform to the `/enroll` contract + stable `clientId`
  (owned by this repo's contract; tracked separately).
