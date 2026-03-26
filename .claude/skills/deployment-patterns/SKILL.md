---
name: deployment-patterns
description: Deployment workflows, CI/CD pipeline patterns, Docker Compose containerization, health checks, rollback strategies, and production readiness checklists optimized for HashHive's air-gapped Docker Compose deployment.
origin: ECC
---

# Deployment Patterns

> **HashHive context:** This skill is optimized for HashHive's deployment model — an air-gapped private lab
> running Docker Compose only (no Kubernetes, no Vercel, no cloud providers). All images and dependencies must
> be fully self-contained. GitHub Actions CI runs on internet-connected runners; production has zero internet
> access. Services: Bun backend, Vite frontend, PostgreSQL, Redis, MinIO.

Production deployment workflows and CI/CD best practices.

## When to Activate

- Setting up or modifying GitHub Actions CI/CD pipelines
- Writing or updating Dockerfiles or `docker-compose.yml`
- Planning a deployment or service update in the air-gapped lab
- Implementing health checks and dependency readiness checks
- Preparing for a production release
- Configuring environment-specific settings
- Exporting images for transfer to the air-gapped environment

## Deployment Strategy

HashHive uses a single-node **Docker Compose replacement** strategy:

```
Current stack: all services running via docker compose up -d

Deploy new version:
  1. Build all images on an internet-connected machine (or CI)
  2. Export images as tar archives and transfer to lab
  3. Load images on the lab host: docker load -i <image>.tar
  4. docker compose pull (no-op in air-gap, images already loaded)
  5. docker compose up -d --remove-orphans
  6. Verify health checks pass
  7. If failure: docker compose up -d (re-pins to previous compose state)
```

There is no blue-green or canary infrastructure — the lab runs a single compose stack. Rollback means
re-loading the previous image tars and re-running compose.

## Docker

### Multi-Stage Dockerfile (Bun backend)

```dockerfile
# Stage 1: Install dependencies with cache mount
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile

# Stage 2: Build shared package, then backend
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun --filter @hashhive/shared build
RUN bun --filter @hashhive/backend build

# Stage 3: Minimal production image
FROM oven/bun:1-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser

COPY --from=builder --chown=appuser:appgroup /app/packages/backend/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/packages/shared/dist ./shared
COPY --from=builder --chown=appuser:appgroup /app/packages/backend/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["bun", "dist/server.js"]
```

### Multi-Stage Dockerfile (Vite frontend — served via nginx)

```dockerfile
# Stage 1: Build with Bun
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lockb ./
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile
COPY . .
RUN bun --filter @hashhive/shared build
RUN bun --filter @hashhive/frontend build

# Stage 2: Serve with nginx
FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1
```

### Docker Compose (production)

```yaml
# docker-compose.yml — single source of truth for the production stack
services:
  backend:
    image: hashhive/backend:${IMAGE_TAG:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    env_file: .env
    ports:
      - "3000:3000"
    deploy:
      resources:
        limits:
          memory: 512m

  frontend:
    image: hashhive/frontend:${IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      - backend

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    volumes:
      - minio_data:/data
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    command: server /data --console-address ":9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 15s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

### Docker Best Practices

```
GOOD practices:
- Use specific version tags (oven/bun:1-alpine, postgres:16-alpine — never :latest for first-party images)
- Multi-stage builds to minimize image size
- Run as non-root user
- Copy dependency lockfiles first to maximize layer cache hits
- Use .dockerignore to exclude node_modules, .git, tests, dist
- Add HEALTHCHECK instruction to every service image
- Set memory limits in compose deploy.resources
- Use depends_on with condition: service_healthy for startup ordering

BAD practices:
- Running as root
- Using :latest tags (unpredictable in air-gapped environments)
- Copying the entire monorepo in one COPY layer
- Installing dev dependencies in production image
- Storing secrets in image layers (use env_file or Docker secrets)
- Pulling images at compose-up time on the air-gapped host
```

## Air-Gapped Image Workflow

Because the production environment has no internet access, all images must be prepared offline and transferred.

### Export images for transfer (run on CI or internet-connected machine)

```bash
# Build and tag all images
IMAGE_TAG=$(git rev-parse --short HEAD)
docker build -t hashhive/backend:${IMAGE_TAG} -f packages/backend/Dockerfile .
docker build -t hashhive/frontend:${IMAGE_TAG} -f packages/frontend/Dockerfile .

# Export as tarballs for physical or secure-network transfer
docker save hashhive/backend:${IMAGE_TAG} | gzip > backend-${IMAGE_TAG}.tar.gz
docker save hashhive/frontend:${IMAGE_TAG} | gzip > frontend-${IMAGE_TAG}.tar.gz

# Also export third-party images if updating them
docker pull postgres:16-alpine redis:7-alpine minio/minio:latest
docker save postgres:16-alpine redis:7-alpine minio/minio:latest | gzip > infra-images.tar.gz
```

### Load and deploy on the air-gapped host

```bash
# Transfer tarballs via USB/secure copy, then:
docker load -i backend-${IMAGE_TAG}.tar.gz
docker load -i frontend-${IMAGE_TAG}.tar.gz
# Only needed when updating infra images:
docker load -i infra-images.tar.gz

# Deploy
IMAGE_TAG=${IMAGE_TAG} docker compose up -d --remove-orphans

# Run migrations against the live database
docker compose exec backend bun run db:migrate

# Verify all services healthy
docker compose ps
docker compose logs --tail=50 backend
```

### Dependency Vendoring

For Bun builds in CI that will be transferred air-gapped:

```bash
# On internet-connected build machine: install with frozen lockfile
bun install --frozen-lockfile

# The bun.lockb is the authoritative lock — never commit node_modules
# Docker multi-stage builds handle node_modules inside the image layer
# No separate vendoring step needed when building Docker images
```

## CI/CD Pipeline (GitHub Actions)

CI runs on internet-connected GitHub runners. The pipeline validates code quality and builds images;
deployment to the air-gapped lab is a manual step (image transfer + compose up).

### Standard CI Pipeline

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Lint
        run: bun lint

      - name: Format check
        run: bun format --check

      - name: Type check
        run: bun type-check

      - name: Build
        run: bun build

      - name: Test
        run: bun test

      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: coverage-${{ github.sha }}
          path: packages/*/coverage/

  build-images:
    needs: ci-check
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Build backend image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: packages/backend/Dockerfile
          push: false
          tags: hashhive/backend:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          outputs: type=docker,dest=/tmp/backend-${{ github.sha }}.tar

      - name: Build frontend image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: packages/frontend/Dockerfile
          push: false
          tags: hashhive/frontend:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          outputs: type=docker,dest=/tmp/frontend-${{ github.sha }}.tar

      - uses: actions/upload-artifact@v7
        with:
          name: docker-images-${{ github.sha }}
          path: /tmp/*.tar
          retention-days: 7
```

### Local CI Check (matches GitHub Actions)

```bash
# Run the full CI pipeline locally before pushing — no Docker needed
just ci-check
# Equivalent to: bun lint && bun format --check && bun type-check && bun build && bun test
```

### Pipeline Stages

```
PR opened:
  lint → format-check → type-check → build → unit tests → integration tests

Merged to main:
  lint → format-check → type-check → build → unit tests → integration tests → build Docker images → upload artifacts

Lab deployment (manual):
  download artifacts → transfer images → docker load → docker compose up -d → db:migrate → smoke check
```

## Health Checks

### Health Check Endpoint (Hono)

```typescript
// packages/backend/src/routes/health.ts
import type { Hono } from "hono";
import { db } from "../db/client.js";
import { sql } from "drizzle-orm";
import { redis } from "../services/redis.js";

export function registerHealthRoutes(app: Hono) {
  // Simple liveness — used by Docker HEALTHCHECK
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Detailed readiness — used for deployment smoke checks
  app.get("/health/ready", async (c) => {
    const checks = await Promise.allSettled([
      db
        .execute(sql`SELECT 1`)
        .then(() => ({ name: "postgres", status: "ok" as const })),
      redis.ping().then(() => ({ name: "redis", status: "ok" as const })),
    ]);

    const results = checks.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { name: "unknown", status: "error" as const },
    );

    const allHealthy = results.every((r) => r.status === "ok");

    return c.json(
      {
        status: allHealthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        version: process.env.APP_VERSION ?? "unknown",
        uptime: process.uptime(),
        checks: Object.fromEntries(results.map((r) => [r.name, r.status])),
      },
      allHealthy ? 200 : 503,
    );
  });
}
```

## Environment Configuration

### Twelve-Factor Pattern

```bash
# .env (never committed — use .env.example as template)
NODE_ENV=production
PORT=3000

DATABASE_URL=postgres://hashhive:secret@postgres:5432/hashhive
REDIS_URL=redis://redis:6379/0

MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ACCESS_KEY=hashhive
MINIO_SECRET_KEY=secret
MINIO_BUCKET=hashhive-resources
MINIO_USE_SSL=false

JWT_SECRET=<min 32 chars, generated with: openssl rand -hex 32>
SESSION_SECRET=<min 32 chars>

LOG_LEVEL=info
APP_VERSION=<git sha, injected at build time>
```

### Configuration Validation (Zod at startup)

```typescript
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// Fail fast at startup — never silently use undefined config
export const env = envSchema.parse(process.env);
```

## Rollback Strategy

HashHive rollback means re-deploying the previous image set on the lab host.

### Rollback Steps

```bash
# 1. Identify the previous working image tag (from CI artifact or image labels)
PREVIOUS_TAG=<previous git sha>

# 2. Re-load previous images if not already present on host
docker load -i backend-${PREVIOUS_TAG}.tar.gz
docker load -i frontend-${PREVIOUS_TAG}.tar.gz

# 3. Update compose to use the previous tag and re-deploy
IMAGE_TAG=${PREVIOUS_TAG} docker compose up -d --remove-orphans

# 4. If migration was destructive, restore from backup first:
docker compose stop backend
pg_restore -d $DATABASE_URL backup-${PREVIOUS_TAG}.dump
docker compose start backend
```

### Rollback Checklist

- [ ] Previous image tarballs are retained (CI artifact retention: 7 days minimum)
- [ ] Database migrations are backward-compatible (additive only — no column drops in the same release)
- [ ] A database backup is taken before any migration that alters existing columns
- [ ] Rollback procedure tested in staging before critical production changes
- [ ] Docker Compose file version-pinned alongside the image tag

## Production Readiness Checklist

Before any lab deployment:

### Application

- [ ] All tests pass locally: `just ci-check`
- [ ] No hardcoded secrets in code, config files, or Dockerfiles
- [ ] Error handling covers all edge cases — no unhandled promise rejections
- [ ] Logging is structured (JSON) and does not contain PII or credentials
- [ ] `/health` and `/health/ready` endpoints return correct status

### Docker / Compose

- [ ] All images build reproducibly with pinned base image versions
- [ ] `.env` updated with correct values for the lab environment
- [ ] `docker compose config` shows no warnings or interpolation errors
- [ ] Resource limits set (`deploy.resources.limits.memory`) for backend and frontend
- [ ] Named volumes confirmed present (no accidental data loss on re-deploy)

### Air-Gapped Transfer

- [ ] All image tarballs transferred to lab host
- [ ] Third-party images updated if base images changed
- [ ] SHA256 checksums verified after transfer (no corruption)

### Database

- [ ] Migration script reviewed — only additive changes in this release
- [ ] Database backup taken immediately before running migrations
- [ ] `db:migrate` tested against a copy of production data if schema changes are significant

### Security

- [ ] No secrets in image layers (`docker history <image>` shows no ENV secrets)
- [ ] CORS configured for internal lab origins only
- [ ] JWT and session secrets are ≥32 random bytes (not default values)
- [ ] MinIO bucket policy allows only authenticated backend access

### Operations

- [ ] Rollback plan documented: which image tag to revert to
- [ ] `docker compose logs` reviewed after deploy — no ERROR-level startup failures
- [ ] All five service health checks green: `docker compose ps`
