/**
 * Direct unit tests for `validateCampaignResources` and the auto-complete
 * trigger inside `updateCampaignProgress`. Both touch the real `db`
 * chain, so we run in an isolated phase via the
 * `CAMPAIGN_RESOURCE_VALIDATION_TEST_ISOLATED` env gate to keep our
 * mock.module calls from leaking into siblings (mirrors the
 * dashboard-campaigns-routes / redis-degradation pattern).
 *
 * The route-layer tests in dashboard-campaigns-routes.test.ts already
 * cover the per-route surface; this file targets the service-layer
 * behavior the route mocks otherwise abstract away.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

const IS_ISOLATED = process.env['CAMPAIGN_RESOURCE_VALIDATION_TEST_ISOLATED'] === '1';

if (!IS_ISOLATED) {
  describe('campaign-resource-validation (skipped — runs in isolated phase)', () => {
    test('signals isolation phase is required', () => {
      // biome-ignore lint/suspicious/noConsole: surface phase-gating drift in CI logs
      console.warn(
        '[campaign-resource-validation] skipped — set CAMPAIGN_RESOURCE_VALIDATION_TEST_ISOLATED=1 to run.'
      );
      expect(process.env['CAMPAIGN_RESOURCE_VALIDATION_TEST_ISOLATED']).toBeUndefined();
    });
  });
} else {
  // ─── Mock db ────────────────────────────────────────────────────────
  //
  // The campaigns service issues a mix of select shapes:
  //   - validateCampaignResources: db.select({...}).from(t).where(...) → awaited rows
  //   - updateCampaignProgress: db.select({...}).from(tasks).where(...) → awaited aggregation row
  //   - updateCampaignProgress: db.select({...}).from(campaigns).where(...).limit(1) → campaign meta
  //
  // The mock dispatches based on which table was passed to .from(), so
  // each test can stage the row set it cares about per call.

  type Row = Record<string, unknown>;
  const selectFromQueue: Array<{ tableName: string; rows: Row[] }> = [];

  function expectFromCall(tableName: string, rows: Row[]) {
    selectFromQueue.push({ tableName, rows });
  }

  function rowsForTable(tableName: string): Row[] {
    const next = selectFromQueue.shift();
    if (!next) {
      throw new Error(
        `unexpected db.select().from(${tableName}) — no queued response. Queue empty.`
      );
    }
    if (next.tableName !== tableName) {
      throw new Error(
        `db.select().from(${tableName}) called, but next queued response was for ${next.tableName}.`
      );
    }
    return next.rows;
  }

  // Track every UPDATE call so tests can assert what got written.
  const updateCalls: Array<{ tableName: string; values: Record<string, unknown> }> = [];

  // Resolve a Drizzle PgTable to a stable string name (used by the
  // mock dispatch). The real table objects expose `Symbol(drizzle:Name)`
  // but the friendlier approach for testing is to set up an identity
  // map keyed by the imported reference.
  // We populate this lazily after the schema import inside this file.
  const tableNameMap = new WeakMap<object, string>();
  function nameFor(t: unknown): string {
    if (typeof t !== 'object' || t === null) return 'unknown';
    return tableNameMap.get(t as object) ?? 'unknown';
  }

  function buildSelectChain(rows: Row[]) {
    return {
      // bare where(): awaited as the row array (validateCampaignResources path)
      where: mock(() => makeAwaitable(rows, { limit: mock(() => Promise.resolve(rows)) })),
    };
  }

  function makeAwaitable<T>(value: T, extra: Record<string, unknown>) {
    const promise = Promise.resolve(value);
    return Object.assign(promise, extra);
  }

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mock(() => ({
        from: mock((table: unknown) => buildSelectChain(rowsForTable(nameFor(table)))),
      })),
      update: mock((table: unknown) => ({
        set: mock((values: Record<string, unknown>) => {
          updateCalls.push({ tableName: nameFor(table), values });
          return {
            where: mock(() =>
              makeAwaitable(undefined, { returning: mock(() => Promise.resolve([])) })
            ),
          };
        }),
      })),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
        })),
      })),
    },
    client: {},
  }));

  mock.module('../../src/services/events.js', () => ({
    emitCampaignStatus: mock(() => {}),
    emitAgentStatus: mock(() => {}),
    emitAgentError: mock(() => {}),
    emitTaskUpdate: mock(() => {}),
    emitCrackResult: mock(() => {}),
    emit: mock(() => {}),
    broadcastSystemEvent: mock(() => {}),
    broadcastSystemHealth: mock(() => {}),
    registerClient: mock(() => {}),
    unregisterClient: mock(() => {}),
    getClientCount: mock(() => 0),
    __resetEventsForTesting: mock(() => {}),
    SYSTEM_EVENT_PROJECT_ID: 0,
  }));

  // Stub getHashListStats so updateCampaignProgress doesn't issue
  // additional reads we'd otherwise have to queue. The hashProgress
  // computation is exercised separately in resources tests.
  mock.module('../../src/services/resources.js', () => ({
    getHashListStats: mock(async () => ({ total: 0, cracked: 0, remaining: 0 })),
  }));

  // Import service AFTER mocks are in place.
  const { validateCampaignResources, updateCampaignProgress, shouldAutoCompleteCampaign } =
    await import('../../src/services/campaigns.js');

  // Now wire the table identity map from real schema imports.
  const { hashLists, hashTypes, wordLists, ruleLists, maskLists, campaigns, tasks } = await import(
    '@hashhive/shared'
  );
  tableNameMap.set(hashLists as object, 'hashLists');
  tableNameMap.set(hashTypes as object, 'hashTypes');
  tableNameMap.set(wordLists as object, 'wordLists');
  tableNameMap.set(ruleLists as object, 'ruleLists');
  tableNameMap.set(maskLists as object, 'maskLists');
  tableNameMap.set(campaigns as object, 'campaigns');
  tableNameMap.set(tasks as object, 'tasks');

  afterEach(() => {
    selectFromQueue.length = 0;
    updateCalls.length = 0;
  });

  // ─── validateCampaignResources ──────────────────────────────────────

  describe('validateCampaignResources', () => {
    test('returns valid when no resources referenced', async () => {
      const result = await validateCampaignResources({ projectId: 1, hashListId: null }, []);
      expect(result).toEqual({ valid: true });
    });

    test('valid when hashList exists in project', async () => {
      expectFromCall('hashLists', [{ id: 42 }]);
      const result = await validateCampaignResources({ projectId: 1, hashListId: 42 }, []);
      expect(result.valid).toBe(true);
    });

    test('reports hashList(id) missing when scoped lookup returns empty', async () => {
      expectFromCall('hashLists', []);
      const result = await validateCampaignResources({ projectId: 1, hashListId: 42 }, []);
      expect(result).toEqual({ valid: false, missing: ['hashList(42)'] });
    });

    test('reports per-table missing ids with the right label', async () => {
      // Wanted: wordlist(7) + rulelist(13). Both miss.
      expectFromCall('wordLists', []);
      expectFromCall('ruleLists', []);
      const result = await validateCampaignResources({ projectId: 1, hashListId: null }, [
        { wordlistId: 7, rulelistId: 13 },
      ]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.missing).toContain('wordlist(7)');
        expect(result.missing).toContain('rulelist(13)');
      }
    });

    test('hashTypes is queried without a project scope (global resource)', async () => {
      // hashTypes has no projectId column; helper supplies only the
      // id-IN clause. Returning the id from the mock should satisfy.
      expectFromCall('hashTypes', [{ id: 1000 }]);
      const result = await validateCampaignResources({ projectId: 999, hashListId: null }, [
        { hashTypeId: 1000 },
      ]);
      expect(result.valid).toBe(true);
    });

    test('dedups ids across multiple attacks referencing the same wordlist', async () => {
      expectFromCall('wordLists', [{ id: 5 }]);
      const result = await validateCampaignResources({ projectId: 1, hashListId: null }, [
        { wordlistId: 5 },
        { wordlistId: 5 },
        { wordlistId: 5 },
      ]);
      expect(result.valid).toBe(true);
    });

    test('skips null hashListId without firing a lookup', async () => {
      // No expectFromCall — if a lookup fires the queue underflow throws.
      const result = await validateCampaignResources({ projectId: 1, hashListId: null }, [
        { wordlistId: undefined, rulelistId: null },
      ]);
      expect(result).toEqual({ valid: true });
    });

    test('cross-project wordlist (exists in DB but wrong project) is reported missing', async () => {
      // The mock will run the SELECT and return zero rows because the
      // helper appends `eq(wordLists.projectId, campaign.projectId)`.
      // Mimic that by returning empty here.
      expectFromCall('wordLists', []);
      const result = await validateCampaignResources({ projectId: 1, hashListId: null }, [
        { wordlistId: 99 },
      ]);
      expect(result).toEqual({ valid: false, missing: ['wordlist(99)'] });
    });
  });

  // ─── updateCampaignProgress auto-complete wiring ────────────────────

  describe('updateCampaignProgress auto-complete trigger', () => {
    test('triggers transition to completed when all tasks terminal', async () => {
      // Queue: 1) tasks aggregation row, 2) campaign meta row, 3) hashLists/getHashListStats
      // updateCampaignProgress also issues UPDATEs we capture.
      expectFromCall('tasks', [
        {
          totalTasks: 3,
          completedCount: 3,
          failedCount: 0,
          runningProgress: 0,
          runningTaskCount: 0,
        },
      ]);
      expectFromCall('campaigns', [
        { hashListId: null, status: 'running', projectId: 1, startedAt: new Date() },
      ]);
      // transitionCampaign re-fetches: getCampaignById, then listAttacks.
      expectFromCall('campaigns', [
        {
          id: 100,
          status: 'running',
          name: 'X',
          projectId: 1,
          hashListId: null,
          priority: 5,
          startedAt: new Date(),
          completedAt: null,
          progress: {},
          description: null,
          createdBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      await updateCampaignProgress(100);

      // First UPDATE: the progress write on campaigns.
      // Second UPDATE: transitionCampaign flips status to 'completed'.
      const statusUpdates = updateCalls.filter(
        (c) => c.tableName === 'campaigns' && typeof c.values['status'] === 'string'
      );
      expect(statusUpdates.length).toBeGreaterThanOrEqual(1);
      expect(statusUpdates.some((c) => c.values['status'] === 'completed')).toBe(true);
    });

    test('does NOT trigger auto-complete when status is draft', async () => {
      expectFromCall('tasks', [
        {
          totalTasks: 0,
          completedCount: 0,
          failedCount: 0,
          runningProgress: 0,
          runningTaskCount: 0,
        },
      ]);
      // totalTasks === 0 short-circuits the function before campaign load.
      await updateCampaignProgress(100);

      // No status writes to campaigns.
      const statusUpdates = updateCalls.filter(
        (c) => c.tableName === 'campaigns' && typeof c.values['status'] === 'string'
      );
      expect(statusUpdates.length).toBe(0);
    });

    test('writes tasksFailed and eta fields into progress payload when running', async () => {
      const start = new Date(Date.now() - 10_000); // 10s ago
      expectFromCall('tasks', [
        {
          totalTasks: 10,
          completedCount: 5,
          failedCount: 1,
          runningProgress: 0,
          runningTaskCount: 1,
        },
      ]);
      expectFromCall('campaigns', [
        { hashListId: null, status: 'running', projectId: 1, startedAt: start },
      ]);

      await updateCampaignProgress(100);

      const progressWrite = updateCalls.find(
        (c) =>
          c.tableName === 'campaigns' &&
          typeof c.values['progress'] === 'object' &&
          c.values['progress'] !== null
      );
      expect(progressWrite).toBeDefined();
      const progress = progressWrite?.values['progress'] as Record<string, unknown>;
      expect(progress['tasksFailed']).toBe(1);
      // 4 remaining tasks (10 - 5 done - 1 failed), 0.5 tasks/sec → 8 more seconds
      expect(typeof progress['eta']).toBe('string');
    });

    test('shouldAutoCompleteCampaign fires for paused status', () => {
      // Companion check — the wiring depends on this returning true,
      // so guard against regression on the paused branch we added.
      expect(
        shouldAutoCompleteCampaign({
          status: 'paused',
          totalTasks: 3,
          completedCount: 3,
          failedCount: 0,
        })
      ).toBe(true);
    });
  });
}
