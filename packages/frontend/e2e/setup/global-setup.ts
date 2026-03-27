import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { FullConfig } from '@playwright/test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { seedTestData } from './seed-data';

const __dirname = dirname(fileURLToPath(import.meta.url));

const S3_BUCKET = 'hashhive';
const S3_ACCESS_KEY = 'minioadmin';
const S3_SECRET_KEY = 'minioadmin';
const BETTER_AUTH_SECRET = 'e2e-test-betterauth-secret-must-be-at-least-32-characters';
const BACKEND_CWD = resolve(__dirname, '../../../backend');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TestContainersState {
  mode: 'testcontainers';
  pgContainer: StartedPostgreSqlContainer;
  redisContainer: StartedTestContainer;
  minioContainer: StartedTestContainer;
  backendProcess: ChildProcess;
}

interface DockerComposeState {
  mode: 'docker-compose';
  composeFile: string;
  backendProcess: ChildProcess;
}

type E2EGlobalState = TestContainersState | DockerComposeState;

// Store references for teardown
declare global {
  // biome-ignore lint/style/noVar: required for Playwright global state
  var __e2eState: E2EGlobalState | undefined;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
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
  });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    console.log(`[E2E] Bucket '${S3_BUCKET}' already exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    // Verify bucket was created
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    console.log(`[E2E] Created and verified bucket '${S3_BUCKET}'`);
  } finally {
    s3.destroy();
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
  };
}

function runMigrations(databaseUrl: string, redisUrl: string, s3Endpoint: string): void {
  console.log('[E2E] Pushing database schema...');
  try {
    execFileSync('bun', ['run', 'db:push'], {
      cwd: BACKEND_CWD,
      env: buildBackendEnv(databaseUrl, redisUrl, s3Endpoint),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('[E2E] Schema push complete');
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
    throw new Error(`Schema push failed: ${stderr}`);
  }
}

function startBackend(databaseUrl: string, redisUrl: string, s3Endpoint: string): ChildProcess {
  return spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND_CWD,
    env: {
      ...buildBackendEnv(databaseUrl, redisUrl, s3Endpoint),
      PORT: '4000',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
    },
    stdio: 'inherit',
  });
}

async function waitForDockerComposeReady(composeFile: string): Promise<void> {
  console.log('[E2E] Waiting for docker compose services to be healthy...');
  const start = Date.now();
  const timeoutMs = 60_000;

  while (Date.now() - start < timeoutMs) {
    try {
      const output = execFileSync(
        'docker',
        ['compose', '-f', composeFile, 'ps', '--format', 'json'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
      );

      // docker compose ps --format json outputs one JSON object per line
      const services = output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const allHealthy =
        services.length >= 3 &&
        services.every(
          (s: { Health: string; State: string }) =>
            s['Health'] === 'healthy' || s['State'] === 'running'
        );
      if (allHealthy) {
        console.log('[E2E] All docker compose services are ready');
        return;
      }
    } catch {
      // Command failed or JSON parse failed, services not ready yet
    }

    await sleep(2_000);
  }

  throw new Error(`Docker compose services did not become healthy within ${timeoutMs}ms`);
}

async function setupWithDockerCompose(composeFile: string): Promise<DockerComposeState> {
  console.log('[E2E] Starting infrastructure via docker compose...');

  try {
    execFileSync('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait'], {
      stdio: 'inherit',
    });
  } catch {
    throw new Error('docker compose up failed');
  }

  await waitForDockerComposeReady(composeFile);

  // Docker compose uses default ports from docker-compose.yml
  const databaseUrl = 'postgresql://hashhive:hashhive@localhost:5432/hashhive';
  const redisUrl = 'redis://localhost:6379';
  const s3Endpoint = 'http://localhost:9000';

  // Create MinIO bucket
  await createMinioBucket(s3Endpoint);

  // Run migrations
  runMigrations(databaseUrl, redisUrl, s3Endpoint);

  // Seed test data
  console.log('[E2E] Seeding test data...');
  const { userId, projectId } = await seedTestData(databaseUrl);
  console.log(`[E2E] Seeded user=${userId}, project=${projectId}`);

  // Start backend
  console.log('[E2E] Starting backend server...');
  const backendProcess = startBackend(databaseUrl, redisUrl, s3Endpoint);
  await waitForServer('http://localhost:4000/health');
  console.log('[E2E] Backend server ready');

  return { mode: 'docker-compose', composeFile, backendProcess };
}

async function setupWithTestcontainers(): Promise<TestContainersState> {
  console.log('[E2E] Starting infrastructure via testcontainers...');

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
  ]);

  console.log('[E2E] Containers started');

  const databaseUrl = pgContainer.getConnectionUri();
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  const minioHost = minioContainer.getHost();
  const minioPort = minioContainer.getMappedPort(9000);
  const s3Endpoint = `http://${minioHost}:${minioPort}`;

  // Create MinIO bucket
  await createMinioBucket(s3Endpoint);

  // Run migrations
  runMigrations(databaseUrl, redisUrl, s3Endpoint);

  // Seed test data
  console.log('[E2E] Seeding test data...');
  const { userId, projectId } = await seedTestData(databaseUrl);
  console.log(`[E2E] Seeded user=${userId}, project=${projectId}`);

  // Start backend
  console.log('[E2E] Starting backend server...');
  const backendProcess = startBackend(databaseUrl, redisUrl, s3Endpoint);
  await waitForServer('http://localhost:4000/health');
  console.log('[E2E] Backend server ready');

  return { mode: 'testcontainers', pgContainer, redisContainer, minioContainer, backendProcess };
}

async function globalSetup(_config: FullConfig): Promise<void> {
  console.log('[E2E] Starting test infrastructure...');

  const useDockerCompose = process.env['E2E_USE_DOCKER_COMPOSE'] === 'true';
  const composeFile = resolve(__dirname, '../../../../docker-compose.yml');

  const state = useDockerCompose
    ? await setupWithDockerCompose(composeFile)
    : await setupWithTestcontainers();

  globalThis.__e2eState = state;

  // Set env vars for Playwright tests (used by webServer proxy)
  process.env['E2E_BACKEND_URL'] = 'http://localhost:4000';
}

export default globalSetup;
