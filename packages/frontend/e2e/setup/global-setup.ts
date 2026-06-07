import type { FullConfig } from '@playwright/test'

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'

import { seedTestData } from './seed-data'

const __dirname = dirname(fileURLToPath(import.meta.url))

const S3_BUCKET = 'hashhive'
const S3_ACCESS_KEY = 'minioadmin'
const S3_SECRET_KEY = 'minioadmin'
const BETTER_AUTH_SECRET = 'e2e-test-betterauth-secret-must-be-at-least-32-characters'
const BACKEND_CWD = resolve(__dirname, '../../../backend')

// E2E backend listens on a port distinct from the dev backend (4000) so
// the suite can run alongside `just dev` without colliding. Kept in
// sync with `E2E_BACKEND_PORT` in playwright.config.ts — both default
// to 4400, both honor the env var override.
const E2E_BACKEND_PORT = process.env['E2E_BACKEND_PORT'] ?? '4400'
const E2E_BACKEND_URL = `http://localhost:${E2E_BACKEND_PORT}`
const E2E_FRONTEND_PORT = process.env['E2E_FRONTEND_PORT'] ?? '3400'
const E2E_FRONTEND_URL = `http://localhost:${E2E_FRONTEND_PORT}`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface TestContainersState {
  mode: 'testcontainers'
  pgContainer: StartedPostgreSqlContainer
  redisContainer: StartedTestContainer
  minioContainer: StartedTestContainer
  backendProcess: ChildProcess
}

interface DockerComposeState {
  mode: 'docker-compose'
  composeFile: string
  backendProcess: ChildProcess
}

type E2EGlobalState = TestContainersState | DockerComposeState

// Store references for teardown
declare global {
  // oxlint-disable-next-line no-var -- required for Playwright global state
  var __e2eState: E2EGlobalState | undefined
}

/**
 * Pre-flight port-ownership probe. Attempts to bind a throwaway listener
 * on the given port and immediately closes. Throws if the port is
 * already taken — this is the failure the prior PORT=4000 bug hid:
 * `spawn` doesn't fail synchronously on EADDRINUSE, and `waitForServer`
 * sees ANY 2xx at /health (including a squatter's). Failing loud here
 * is the only way to keep the suite from authenticating against the
 * wrong backend.
 */
function assertPortFree(port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `${label} port ${port} is already in use. Stop the conflicting process, ` +
              `or override with E2E_BACKEND_PORT / E2E_FRONTEND_PORT.`
          )
        )
      } else {
        reject(err)
      }
    })
    server.once('listening', () => {
      server.close((closeErr) => (closeErr ? reject(closeErr) : resolve()))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5_000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) return
    } catch {
      // Server not ready yet
    }
    await sleep(500)
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`)
}

async function createMinioBucket(endpoint: string): Promise<void> {
  const s3 = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
    forcePathStyle: true,
  })

  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
    console.log(`[E2E] Bucket '${S3_BUCKET}' already exists`)
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
    // Verify bucket was created
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
    console.log(`[E2E] Created and verified bucket '${S3_BUCKET}'`)
  } finally {
    s3.destroy()
  }
}

function buildBackendEnv(databaseUrl: string, redisUrl: string, s3Endpoint: string) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: s3Endpoint,
    S3_ACCESS_KEY: S3_ACCESS_KEY,
    S3_SECRET_KEY: S3_SECRET_KEY,
    S3_BUCKET: S3_BUCKET,
    BETTER_AUTH_SECRET: BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: E2E_BACKEND_URL,
    // Authorize the E2E frontend's origin so BetterAuth's same-origin
    // check accepts /api/auth/* and /projects/select from localhost:3400
    // (or whatever E2E_FRONTEND_PORT is set to).
    BETTER_AUTH_TRUSTED_ORIGINS: E2E_FRONTEND_URL,
  }
}

function runMigrations(databaseUrl: string, redisUrl: string, s3Endpoint: string): void {
  console.log('[E2E] Pushing database schema...')
  try {
    execFileSync('bun', ['run', 'db:push'], {
      cwd: BACKEND_CWD,
      env: buildBackendEnv(databaseUrl, redisUrl, s3Endpoint),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log('[E2E] Schema push complete')
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err)
    throw new Error(`Schema push failed: ${stderr}`)
  }
}

function runAuthMigration(databaseUrl: string, redisUrl: string, s3Endpoint: string): void {
  console.log('[E2E] Running BetterAuth account migration...')
  try {
    execFileSync('bun', ['run', 'src/scripts/migrate-auth-accounts.ts'], {
      cwd: BACKEND_CWD,
      env: buildBackendEnv(databaseUrl, redisUrl, s3Endpoint),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log('[E2E] Auth migration complete')
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err)
    throw new Error(`Auth migration failed: ${stderr}`)
  }
}

function startBackend(databaseUrl: string, redisUrl: string, s3Endpoint: string): ChildProcess {
  const proc = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND_CWD,
    env: {
      ...buildBackendEnv(databaseUrl, redisUrl, s3Endpoint),
      PORT: E2E_BACKEND_PORT,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
    },
    stdio: 'inherit',
  })
  // Make startup failure loud. Without these listeners, a backend that
  // exits during the waitForServer window (e.g., EADDRINUSE losing a
  // race to a squatter) leaves waitForServer polling a different
  // process's /health and silently authenticating the suite against
  // the wrong DB. assertPortFree above is the primary guard; these
  // handlers cover the case where something binds the port between
  // the probe and the spawn.
  proc.on('error', (err) => {
    throw new Error(`[E2E] backend spawn failed: ${err.message}`)
  })
  proc.on('exit', (code, signal) => {
    // Code 0 only happens at orderly teardown (signal SIGTERM/SIGINT
    // from globalTeardown). A non-zero / non-signal exit during the
    // run is a startup failure we want to surface immediately.
    if (code !== null && code !== 0) {
      throw new Error(`[E2E] backend exited unexpectedly: code=${code} signal=${signal ?? 'null'}`)
    }
  })
  return proc
}

async function waitForDockerComposeReady(composeFile: string): Promise<void> {
  console.log('[E2E] Waiting for docker compose services to be healthy...')
  const start = Date.now()
  const timeoutMs = 60_000

  while (Date.now() - start < timeoutMs) {
    try {
      const output = execFileSync(
        'docker',
        ['compose', '-f', composeFile, 'ps', '--format', 'json'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
      )

      // docker compose ps --format json outputs one JSON object per line
      const services = output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const allHealthy =
        services.length >= 3 &&
        services.every(
          (s: { Health: string; State: string }) =>
            s['Health'] === 'healthy' || s['State'] === 'running'
        )
      if (allHealthy) {
        console.log('[E2E] All docker compose services are ready')
        return
      }
    } catch {
      // Command failed or JSON parse failed, services not ready yet
    }

    await sleep(2_000)
  }

  throw new Error(`Docker compose services did not become healthy within ${timeoutMs}ms`)
}

async function setupWithDockerCompose(composeFile: string): Promise<DockerComposeState> {
  console.log('[E2E] Starting infrastructure via docker compose...')

  try {
    execFileSync('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait'], {
      stdio: 'inherit',
    })
  } catch {
    throw new Error('docker compose up failed')
  }

  await waitForDockerComposeReady(composeFile)

  // Docker compose uses default ports from docker-compose.yml
  const databaseUrl = 'postgresql://hashhive:hashhive@localhost:5432/hashhive'
  const redisUrl = 'redis://localhost:6379'
  const s3Endpoint = 'http://localhost:9000'

  // Create MinIO bucket
  await createMinioBucket(s3Endpoint)

  // Run migrations
  runMigrations(databaseUrl, redisUrl, s3Endpoint)

  // Seed test data
  console.log('[E2E] Seeding test data...')
  const { userId, projectId } = await seedTestData(databaseUrl)
  console.log(`[E2E] Seeded user=${userId}, project=${projectId}`)

  // Migrate user credentials to BetterAuth ba_accounts table
  runAuthMigration(databaseUrl, redisUrl, s3Endpoint)

  // Start backend (assert port is free first so a squatting process
  // can't silently hand us the wrong /health response)
  console.log('[E2E] Starting backend server...')
  await assertPortFree(Number(E2E_BACKEND_PORT), 'E2E backend')
  const backendProcess = startBackend(databaseUrl, redisUrl, s3Endpoint)
  await waitForServer(`${E2E_BACKEND_URL}/health`)
  console.log('[E2E] Backend server ready')

  return { mode: 'docker-compose', composeFile, backendProcess }
}

async function setupWithTestcontainers(): Promise<TestContainersState> {
  console.log('[E2E] Starting infrastructure via testcontainers...')

  // Start containers in parallel
  const [pgContainer, redisContainer, minioContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('hashhive_test')
      .withUsername('hashhive')
      .withPassword('hashhive')
      .start(),

    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),

    new GenericContainer('minio/minio')
      .withExposedPorts(9000)
      .withCommand(['server', '/data'])
      .withEnvironment({
        MINIO_ROOT_USER: S3_ACCESS_KEY,
        MINIO_ROOT_PASSWORD: S3_SECRET_KEY,
      })
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
      .start(),
  ])

  console.log('[E2E] Containers started')

  const databaseUrl = pgContainer.getConnectionUri()
  const redisHost = redisContainer.getHost()
  const redisPort = redisContainer.getMappedPort(6379)
  const redisUrl = `redis://${redisHost}:${redisPort}`
  const minioHost = minioContainer.getHost()
  const minioPort = minioContainer.getMappedPort(9000)
  const s3Endpoint = `http://${minioHost}:${minioPort}`

  // Create MinIO bucket
  await createMinioBucket(s3Endpoint)

  // Run migrations
  runMigrations(databaseUrl, redisUrl, s3Endpoint)

  // Seed test data
  console.log('[E2E] Seeding test data...')
  const { userId, projectId } = await seedTestData(databaseUrl)
  console.log(`[E2E] Seeded user=${userId}, project=${projectId}`)

  // Migrate user credentials to BetterAuth ba_accounts table
  runAuthMigration(databaseUrl, redisUrl, s3Endpoint)

  // Start backend (assert port is free first so a squatting process
  // can't silently hand us the wrong /health response)
  console.log('[E2E] Starting backend server...')
  await assertPortFree(Number(E2E_BACKEND_PORT), 'E2E backend')
  const backendProcess = startBackend(databaseUrl, redisUrl, s3Endpoint)
  await waitForServer(`${E2E_BACKEND_URL}/health`)
  console.log('[E2E] Backend server ready')

  return { mode: 'testcontainers', pgContainer, redisContainer, minioContainer, backendProcess }
}

async function globalSetup(_config: FullConfig): Promise<void> {
  console.log('[E2E] Starting test infrastructure...')

  const useDockerCompose = process.env['E2E_USE_DOCKER_COMPOSE'] === 'true'
  const composeFile = resolve(__dirname, '../../../../docker-compose.yml')

  const state = useDockerCompose
    ? await setupWithDockerCompose(composeFile)
    : await setupWithTestcontainers()

  globalThis.__e2eState = state

  // Set env vars for Playwright tests (used by webServer proxy)
  process.env['E2E_BACKEND_URL'] = E2E_BACKEND_URL
}

export default globalSetup
