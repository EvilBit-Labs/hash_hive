# Architecture Decision Records

Significant architectural decisions for HashHive, in the lightweight
[Michael Nygard ADR format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Each ADR is immutable once accepted — supersede rather than rewrite.

| ADR                                                 | Title                                       | Status   | Date       |
| --------------------------------------------------- | ------------------------------------------- | -------- | ---------- |
| [0001](0001-agent-enrollment-two-token-exchange.md) | Agent enrollment via two-token exchange     | accepted | 2026-06-18 |
| [0002](0002-docker-supervision-over-pm2.md)         | Docker/systemd process supervision over PM2 | proposed | 2026-06-18 |
| [0003](0003-bind-agent-to-enrollment-token.md)      | Bind enrolled agents to their enrollment token | accepted | 2026-06-18 |
| [0004](0004-agent-api-revisable-until-1.0.md)       | The agent API stays revisable until 1.0     | accepted | 2026-06-18 |
| [0005](0005-version-public-api-after-1.0.md)        | Version the public API after 1.0            | accepted | 2026-06-18 |
| [0006](0006-seaweedfs-over-minio.md)                | SeaweedFS over MinIO for object storage     | accepted | 2026-06-18 |
| [0007](0007-three-api-surfaces.md)                  | Three distinct API surfaces                 | accepted | 2026-06-18 |
| [0008](0008-betterauth-over-handrolled-jwt.md)      | BetterAuth over hand-rolled JWT for sessions | accepted | 2026-06-18 |
| [0009](0009-postgres-task-store-bullmq-orchestration.md) | PostgreSQL task store, BullMQ orchestration only | accepted | 2026-06-18 |
| [0010](0010-schema-first-drizzle-zod.md)            | Schema-first: Drizzle as source of types    | accepted | 2026-06-18 |
| [0011](0011-pull-advisory-notify-task-distribution.md) | Hybrid pull + advisory-notify task distribution | accepted | 2026-06-18 |
| [0012](0012-in-memory-websocket-v1-redis-deferred.md) | In-memory WebSocket v1, Redis pub/sub deferred | accepted | 2026-06-18 |
| [0013](0013-route-as-spec-hono-zod-openapi.md)      | Route-as-spec via @hono/zod-openapi         | accepted | 2026-06-18 |
| [0014](0014-turborepo-bun-over-nx.md)               | Turborepo + Bun workspaces over NX          | accepted | 2026-06-18 |
| [0015](0015-append-only-telemetry-timescaledb-rrd.md) | Append-only progress telemetry + TimescaleDB RRD retention | accepted | 2026-06-19 |
| [0016](0016-server-fanout-bus.md)                   | Server-to-server fan-out bus (LISTEN/NOTIFY first) | accepted | 2026-06-19 |
| [0017](0017-adaptive-task-sizing-lease.md)          | Adaptive task sizing with lease + committed-offset | accepted | 2026-06-19 |
| [0018](0018-real-db-integration-test-lane.md)       | Real-DB integration test lane for DB-layer correctness | accepted | 2026-06-19 |
