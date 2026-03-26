---
name: docker-patterns
description: Docker and Docker Compose patterns for air-gapped, self-contained deployments. Optimized for HashHive's Docker Compose-only production stack (Bun backend, Vite/React frontend, PostgreSQL, Redis, MinIO) where all images and dependencies must be fully self-contained with no external network access at runtime.
origin: ECC
---

# Docker Patterns

> **HashHive context:** Production runs in an air-gapped private lab. Docker Compose is the ONLY supported deployment method. No Kubernetes, no cloud services. All images must be pre-pulled and vendored before transport to the air-gapped environment. No CDN, no external registries, no internet access at runtime.

Docker and Docker Compose best practices for containerized development and air-gapped production deployment.

## When to Activate

- Setting up Docker Compose for local development or production
- Designing the HashHive multi-container stack (backend, frontend, PostgreSQL, Redis, MinIO)
- Troubleshooting container networking or volume issues
- Reviewing Dockerfiles for security and size
- Preparing images for transport to air-gapped production environment

## Docker Compose for HashHive

### HashHive Full Stack

```yaml
# docker-compose.yml
services:
  backend:
    build:
      context: ./packages/backend
      target: dev # Use dev stage of multi-stage Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - ./packages/backend:/app # Bind mount for hot reload
      - /app/node_modules # Anonymous volume -- preserves container deps
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/hashhive_dev
      - REDIS_URL=redis://redis:6379/0
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=minioadmin
      - MINIO_SECRET_KEY=minioadmin
      - NODE_ENV=development
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
      minio:
        condition: service_started
    command: bun run dev

  frontend:
    build:
      context: ./packages/frontend
      target: dev
    ports:
      - "5173:5173"
    volumes:
      - ./packages/frontend:/app
      - /app/node_modules
    environment:
      - VITE_API_URL=http://localhost:3000
    depends_on:
      - backend
    command: bun run dev

  db:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: hashhive_dev
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

  minio:
    image: minio/minio:latest
    ports:
      - "9000:9000" # S3 API
      - "9001:9001" # Web console
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - miniodata:/data
    command: server /data --console-address ":9001"
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  redisdata:
  miniodata:
```

### Development vs Production Dockerfile (Bun Backend)

```dockerfile
# packages/backend/Dockerfile

# Stage: dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Stage: dev (hot reload, debug tools)
FROM oven/bun:1-alpine AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["bun", "run", "dev"]

# Stage: build
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Stage: production (minimal image)
FROM oven/bun:1-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser
COPY --from=build --chown=appuser:appgroup /app/dist ./dist
COPY --from=build --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /app/package.json ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["bun", "run", "dist/index.js"]
```

### Frontend Dockerfile (Vite/React — served via nginx)

```dockerfile
# packages/frontend/Dockerfile

# Stage: dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Stage: dev
FROM oven/bun:1-alpine AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5173
CMD ["bun", "run", "dev", "--host"]

# Stage: build
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Stage: production (nginx serves the static build)
FROM nginx:alpine AS production
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/health || exit 1
```

### Override Files

```yaml
# docker-compose.override.yml (auto-loaded, dev-only settings)
services:
  backend:
    environment:
      - DEBUG=hashhive:*
      - LOG_LEVEL=debug
    ports:
      - "9229:9229"                   # Bun debugger

# docker-compose.prod.yml (explicit for air-gapped production)
services:
  backend:
    build:
      target: production
    restart: always
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 1G

  frontend:
    build:
      target: production
    restart: always

  db:
    restart: always

  redis:
    restart: always

  minio:
    restart: always
```

```bash
# Development (auto-loads override)
docker compose up

# Production (air-gapped)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Air-Gapped Deployment Considerations

### Pre-pulling and Exporting Images

Because the production environment has no internet access, all images must be saved and transported before deployment:

```bash
# On an internet-connected system — pull all required images
docker pull oven/bun:1-alpine
docker pull postgres:16-alpine
docker pull redis:7-alpine
docker pull minio/minio:latest
docker pull nginx:alpine

# Save all images to a tarball for transport
docker save \
  oven/bun:1-alpine \
  postgres:16-alpine \
  redis:7-alpine \
  minio/minio:latest \
  nginx:alpine \
  | gzip > hashhive-images.tar.gz

# On the air-gapped production system — load images
docker load < hashhive-images.tar.gz
```

### Vendored Dependencies

Never rely on `bun install` running in production — all dependencies must be installed during the build stage on an internet-connected system and baked into the image:

```dockerfile
# CORRECT: Install during build, copy to production stage
FROM oven/bun:1-alpine AS deps
RUN bun install --frozen-lockfile   # Runs on build machine (internet access)

FROM oven/bun:1-alpine AS production
COPY --from=deps /app/node_modules ./node_modules  # Baked into image
```

### No CDN or External URLs

- Do not load fonts, icons, or scripts from external CDNs (Google Fonts, jsDelivr, unpkg, etc.)
- All static assets must be bundled into the Vite build output
- Vite's build step runs on an internet-connected dev/CI machine; the output is a fully self-contained `/dist`

### MinIO Bucket Initialization

MinIO buckets must be created before first use. Use an init container or startup script that runs within the Docker network — never an external call:

```yaml
services:
  minio-init:
    image: minio/mc:latest # mc (MinIO client) — must be pre-pulled too
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
        mc alias set local http://minio:9000 minioadmin minioadmin &&
        mc mb --ignore-existing local/hashhive-resources &&
        mc mb --ignore-existing local/hashhive-uploads
      "
    restart: "no"
```

### Large File Handling

Individual wordlists, rulelists, and masklists can exceed 100 GB. Docker volumes back MinIO storage — ensure the host has sufficient disk:

```yaml
services:
  minio:
    volumes:
      - type: bind
        source: /mnt/storage/minio # Map to large storage mount on host
        target: /data
```

## Networking

### Service Discovery

Services in the same Compose network resolve by service name:

```
# From "backend" container:
postgres://postgres:postgres@db:5432/hashhive_dev    # "db" resolves to the db container
redis://redis:6379/0                                  # "redis" resolves to the redis container
http://minio:9000                                     # "minio" resolves to the MinIO container
```

### Custom Networks

```yaml
services:
  frontend:
    networks:
      - frontend-net

  backend:
    networks:
      - frontend-net
      - backend-net

  db:
    networks:
      - backend-net # Only reachable from backend, not frontend

  redis:
    networks:
      - backend-net

  minio:
    networks:
      - backend-net

networks:
  frontend-net:
  backend-net:
```

### Exposing Only What's Needed

```yaml
services:
  db:
    ports:
      - "127.0.0.1:5432:5432" # Only accessible from host, not network
    # Omit ports entirely in production -- accessible only within Docker network
```

## Volume Strategies

```yaml
volumes:
  # Named volume: persists across container restarts, managed by Docker
  pgdata:
  redisdata:
  miniodata:

  # Bind mount: maps host directory into container (for development or large storage)
  # - /mnt/storage/minio:/data

  # Anonymous volume: preserves container-generated content from bind mount override
  # - /app/node_modules
```

### Common Patterns

```yaml
services:
  backend:
    volumes:
      - ./packages/backend:/app # Source code (bind mount for hot reload)
      - /app/node_modules # Protect container's node_modules from host

  db:
    volumes:
      - pgdata:/var/lib/postgresql/data # Persistent data
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql # Init scripts

  minio:
    volumes:
      - miniodata:/data # Object storage (wordlists, hash lists, etc.)
```

## Container Security

### Dockerfile Hardening

```dockerfile
# 1. Use specific tags (never :latest in production)
FROM oven/bun:1.2.5-alpine3.20

# 2. Run as non-root
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
USER app

# 3. Drop capabilities (in compose)
# 4. Read-only root filesystem where possible
# 5. No secrets in image layers
```

### Compose Security

```yaml
services:
  backend:
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /app/.cache
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE # Only if binding to ports < 1024
```

### Secret Management

```yaml
# GOOD: Use environment variables (injected at runtime)
services:
  backend:
    env_file:
      - .env                     # Never commit .env to git
    environment:
      - JWT_SECRET               # Inherits from host environment

# GOOD: Docker secrets (Compose file secrets, not Swarm-only)
secrets:
  db_password:
    file: ./secrets/db_password.txt

services:
  db:
    secrets:
      - db_password

# BAD: Hardcoded in image
# ENV JWT_SECRET=supersecret      # NEVER DO THIS
```

## .dockerignore

```
node_modules
.git
.env
.env.*
dist
coverage
*.log
.cache
docker-compose*.yml
Dockerfile*
README.md
tests/
```

## Debugging

### Common Commands

```bash
# View logs
docker compose logs -f backend         # Follow backend logs
docker compose logs --tail=50 db       # Last 50 lines from db

# Execute commands in running container
docker compose exec backend sh         # Shell into backend (Bun)
docker compose exec db psql -U postgres  # Connect to postgres

# Run Drizzle migrations inside the backend container
docker compose exec backend bun run db:migrate

# Inspect
docker compose ps                      # Running services
docker compose top                     # Processes in each container
docker stats                           # Resource usage

# Rebuild
docker compose up --build              # Rebuild images
docker compose build --no-cache backend  # Force full rebuild

# Clean up
docker compose down                    # Stop and remove containers
docker compose down -v                 # Also remove volumes (DESTRUCTIVE)
docker system prune                    # Remove unused images/containers
```

### Debugging Network Issues

```bash
# Check DNS resolution inside container
docker compose exec backend nslookup db

# Check connectivity to MinIO
docker compose exec backend wget -qO- http://minio:9000/minio/health/live

# Check backend health
docker compose exec backend wget -qO- http://localhost:3000/health

# Inspect network
docker network ls
docker network inspect <project>_default
```

## Anti-Patterns

```
# BAD: Running bun install at container startup in production
# All deps must be baked into the image during the build stage

# BAD: Loading assets from external CDNs at runtime
# Bundle everything into the Vite build output; air-gapped env has no internet

# BAD: Storing data in containers without volumes
# Containers are ephemeral -- all data lost on restart without volumes

# BAD: Running as root
# Always create and use a non-root user

# BAD: Using :latest tag in production
# Pin to specific versions for reproducible builds in air-gapped envs

# BAD: One giant container with all services
# Separate concerns: one process per container

# BAD: Putting secrets in docker-compose.yml
# Use .env files (gitignored) or Docker secrets

# BAD: Assuming image pulls will succeed in production
# Pre-pull and docker save/load all images before transporting to air-gapped env
```
