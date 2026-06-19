# ADR-0007: Three distinct API surfaces

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively. HashHive serves three very different clients: the
Go hashcat agents (machine-to-machine, batch, on a private LAN), the React
dashboard (interactive human sessions), and CLI/CI/automation tooling. The
original Tech Plan described only two surfaces (agent + dashboard); a third,
the Control API, was added for tooling. Each client has different auth,
error-handling, and pagination needs.

## Decision

Expose three separate API surfaces, each with its own auth scheme, error
envelope, and pagination:

- **Agent API** (`/api/v1/agent/*`) — pre-shared Bearer token; agent error
  envelope `{ error: { code, message } }`.
- **Dashboard API** (`/api/v1/dashboard/*`) — BetterAuth session cookie;
  `limit`/`offset` pagination; `{ error: { code, message } }` (+ optional
  `timestamp`/`requestId`).
- **Control API** (`/api/v1/control/*`) — per-user `cst_*` API keys
  (bcrypt-hashed); RFC 9457 problem-details (`application/problem+json`);
  `offset`/`limit` pagination.

## Alternatives Considered

### Alternative 1: One unified API with a single auth mechanism

- **Pros**: less surface area; one error format; simpler docs.
- **Cons**: forces one auth model onto clients with incompatible needs
  (machine tokens vs human sessions vs scriptable keys); couples agent
  stability to dashboard churn.
- **Why not**: the consumers' constraints genuinely differ; conflating them
  would make every change risk all clients at once.

## Consequences

### Positive

- Each surface evolves and is secured on its own terms; the agent contract is
  insulated from dashboard changes.
- Error/pagination conventions fit each client's ecosystem (problem-details
  for tooling, envelopes for the agent).

### Negative

- Three contracts to document, test, and keep coherent.

### Risks

- The Tech Plan still describes only two surfaces and is stale; AGENTS.md is
  authoritative. The agent surface's stability rules differ by lifecycle
  stage — see [ADR-0004](0004-agent-api-revisable-until-1.0.md) and
  [ADR-0005](0005-version-public-api-after-1.0.md).
