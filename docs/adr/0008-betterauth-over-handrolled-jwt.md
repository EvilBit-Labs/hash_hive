# ADR-0008: BetterAuth over hand-rolled JWT for dashboard sessions

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively (migration plan dated 2026-03-27). The original spec
(`spec/tickets/Project_Selection_&_User_Authentication_API.md`) prescribed
hand-rolled JWT issuance and validation with manual HttpOnly session
cookies. Authentication is a security-critical boundary where bespoke code
is a frequent source of subtle, high-impact bugs (token expiry, rotation,
CSRF, session fixation).

## Decision

Use BetterAuth for dashboard authentication — session creation, HttpOnly
cookies, session validation, and account storage — instead of custom JWT
code. CSRF/same-origin checks are enforced via `BETTER_AUTH_TRUSTED_ORIGINS`.

## Alternatives Considered

### Alternative 1: Hand-rolled JWT + manual sessions (original spec)

- **Pros**: no dependency; full control.
- **Cons**: re-implements well-trodden auth machinery; every edge case
  (rotation, revocation, CSRF) is ours to get right.
- **Why not**: the risk/maintenance cost of custom auth outweighs the control
  benefit for a standard email/password + session model.

### Alternative 2: A heavier IdP (e.g. Keycloak)

- **Pros**: enterprise SSO, mature.
- **Why not**: too much operational weight for an air-gapped, single-org
  deployment; BetterAuth fits the embedded model.

## Consequences

### Positive

- Session lifecycle, cookie hardening, and account migration are handled by a
  maintained library rather than bespoke code.
- Consistent integration point for future auth features (2FA, org accounts).

### Negative

- A security-critical dependency to track and update.
- Dev-mode origin checks must read `BETTER_AUTH_TRUSTED_ORIGINS` (any new
  dev-origin site must honor it).

### Risks

- The spec still prescribes custom JWT and is stale; ARCHITECTURE.md /
  AGENTS.md are authoritative.
