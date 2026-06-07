# E2E Tests

End-to-end tests using Playwright with Testcontainers for real infrastructure.

## Prerequisites

- **Docker** must be running (testcontainers manages container lifecycle)
- **Playwright browsers** installed: `bunx playwright install chromium`

## Running

```bash
# From frontend package
bun run test:e2e

# From monorepo root
bun run test:e2e
# or
just test-e2e
```

## Infrastructure Modes

### Testcontainers (default)

By default, the E2E suite uses [Testcontainers](https://testcontainers.com/) to start PostgreSQL, Redis, and MinIO containers with randomized ports. This is the recommended approach for CI and isolated local runs.

```bash
bun run test:e2e
```

### Docker Compose fallback

Set `E2E_USE_DOCKER_COMPOSE=true` to use the root `docker-compose.yml` instead of testcontainers. This is useful when:

- Testcontainers is unavailable or unsupported (e.g. rootless Docker, some CI runners)
- You want to reuse an already-running compose stack
- You need to inspect service logs during test runs

```bash
E2E_USE_DOCKER_COMPOSE=true bun run test:e2e
```

When using docker compose mode:

1. The setup starts `docker compose -f ../../docker-compose.yml up -d --wait`
2. Waits for Postgres, Redis, and MinIO healthchecks to pass
3. Creates the `hashhive` S3 bucket in MinIO
4. Runs Drizzle migrations against `postgresql://hashhive:hashhive@localhost:5432/hashhive`
5. Seeds test data (user + project + membership)
6. Starts the backend Hono server on port 4400 (overridable via `E2E_BACKEND_PORT`)
7. Vite dev server starts via Playwright's `webServer` config on port 3400 (overridable via `E2E_FRONTEND_PORT`) with `VITE_API_PROXY_TARGET` pointing at the backend so it doesn't collide with the dev pair on 3000/4000

Teardown runs `docker compose down -v` to stop services and remove volumes.

**Important:** Docker compose mode uses fixed ports (5432, 6379, 9000) from `docker-compose.yml`. Make sure these ports are not in use by other services.

## Architecture

The E2E suite uses Playwright's `globalSetup` / `globalTeardown` hooks to manage infrastructure:

1. **Global Setup** (`e2e/setup/global-setup.ts`)
   - Starts PostgreSQL, Redis, and MinIO (via testcontainers or docker compose)
   - Creates the `hashhive` S3 bucket in MinIO via AWS SDK
   - Runs Drizzle migrations against the test database
   - Seeds test data (user + project + membership)
   - Starts the backend Hono server on port 4000
   - Vite dev server starts via Playwright's `webServer` config on port 3000

2. **Tests** (`e2e/smoke.spec.ts`)
   - Login with seeded credentials
   - Navigate through all core pages
   - Verify unauthenticated access redirects

3. **Global Teardown** (`e2e/setup/global-teardown.ts`)
   - Stops backend server
   - Stops all testcontainers or runs `docker compose down -v`

## Test Data

| Entity  | Value                    |
|---------|--------------------------|
| Email   | `test@hashhive.local`    |
| Password| `TestPassword123!`       |
| Project | `Test Project`           |
| Roles   | `["admin"]`              |

## Troubleshooting

- **Docker not running**: Both modes require a running Docker daemon
- **Port 4400 / 3400 in use**: The E2E lane is distinct from the dev pair on 4000/3000 so `just dev` and `just test-e2e` can run side by side. If something else is on 4400 or 3400, override with `E2E_BACKEND_PORT=4401 E2E_FRONTEND_PORT=3401 bun run test:e2e`.
- **Container startup slow**: First run pulls Docker images; subsequent runs use cached images
- **Migrations fail**: Ensure `@hashhive/shared` is built (`bun run build` from root)
- **MinIO bucket errors**: The setup automatically creates the `hashhive` bucket; if it already exists, it is reused
- **Docker compose port conflicts**: When using `E2E_USE_DOCKER_COMPOSE=true`, ports 5432, 6379, and 9000 must be free
