import type { FullConfig } from '@playwright/test'

import { execFileSync } from 'node:child_process'

async function globalTeardown(_config: FullConfig): Promise<void> {
  const state = globalThis.__e2eState
  if (!state) {
    console.log('[E2E] No global state found, skipping teardown')
    return
  }

  console.log('[E2E] Tearing down test infrastructure...')

  // 1. Stop backend server
  try {
    state.backendProcess.kill()
    console.log('[E2E] Backend server stopped')
  } catch {
    console.log('[E2E] Backend server already stopped')
  }

  // 2. Stop infrastructure based on mode
  if (state.mode === 'docker-compose') {
    console.log('[E2E] Stopping docker compose stack...')
    try {
      execFileSync('docker', ['compose', '-f', state.composeFile, 'down', '-v'], {
        stdio: 'inherit',
      })
    } catch {
      console.log('[E2E] docker compose down failed')
    }
    console.log('[E2E] Docker compose stack stopped')
  } else {
    // Stop testcontainers — use allSettled so one failure doesn't leak the others
    const results = await Promise.allSettled([
      state.pgContainer.stop().then(() => console.log('[E2E] PostgreSQL container stopped')),
      state.redisContainer.stop().then(() => console.log('[E2E] Redis container stopped')),
      state.minioContainer.stop().then(() => console.log('[E2E] MinIO container stopped')),
    ])
    for (const r of results) {
      if (r.status === 'rejected') {
        console.log(`[E2E] Container stop failed: ${r.reason}`)
      }
    }
  }

  globalThis.__e2eState = undefined
  console.log('[E2E] Teardown complete')
}

export default globalTeardown
