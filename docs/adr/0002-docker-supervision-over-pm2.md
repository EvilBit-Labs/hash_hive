# ADR-0002: Docker/systemd process supervision over PM2

**Date**: 2026-06-18
**Status**: proposed
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)

## Context

HashHive runs three long-lived processes in production — the backend HTTP
server (`bun dist/index.js`), the line-count jobs worker (`worker-jobs.ts`),
and the task-generation worker (`worker-task-generation.ts`) — plus the
Vite/Bun HMR servers in dev. The production target is an air-gapped Docker
Compose deployment; `docker-compose.yml` currently defines only infra
(postgres, redis, seaweedfs). The question arose whether PM2 should supervise
these processes (restart-on-crash, log aggregation, scaling).

## Decision

We do not adopt PM2. In containers, Docker supervises: each process type is its
own Compose service off a shared image with a `restart` policy and
`healthcheck`, scaled via `deploy.replicas`. If a process ever runs directly on
a VM/bare metal, we prefer a systemd unit over PM2.

## Alternatives Considered

### Alternative 1: PM2 inside the container

- **Pros**: familiar Node process manager; built-in restart, log files, an
  ecosystem file to declare all three processes.
- **Cons**: two supervisors (PM2 + Docker) fight over restart/exit-code/signal
  handling; PM2 captures stdout into its own log files instead of `docker logs`,
  degrading observability; an extra runtime to ship into an air-gapped image.
- **Why not**: running a process manager inside a container duplicates what
  Docker already does and is a recognized anti-pattern.

### Alternative 2: PM2 cluster mode for the backend

- **Pros**: PM2's headline feature — fork N workers, load-balance across cores.
- **Why not**: cluster mode depends on Node's `cluster` module, which Bun does
  not support the way PM2 expects. The main reason to reach for PM2 doesn't
  function on this runtime. Horizontal scaling is instead expressed as Compose
  `deploy.replicas`.

### Alternative 3: PM2 (pm2-runtime) on bare metal instead of systemd

- **Pros**: cross-platform; boot persistence; restart supervision without
  containers.
- **Why not**: for a Bun app the cluster benefit is unavailable, so PM2 reduces
  to a supervisor — a role systemd fills natively with journald logging and no
  extra dependency.

## Consequences

### Positive

- One supervision model (Docker) in production; logs flow to
  `docker logs`/the platform's collector unmodified.
- The three process types are independently restartable, scalable, and
  resource-bounded as distinct services.
- Nothing extra to vendor into the air-gapped image.

### Negative

- Scaling and restart semantics live in Compose/orchestrator config rather than
  a single PM2 ecosystem file.
- No PM2 dashboard/`pm2 monit`; process introspection comes from container
  tooling.

### Risks

- The app is not yet containerized (no Dockerfile); this decision is directional
  until the production image and Compose app services exist. Revisit and promote
  to **accepted** when that lands.
