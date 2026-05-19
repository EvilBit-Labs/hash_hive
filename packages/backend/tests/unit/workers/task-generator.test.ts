import { describe, expect, mock, test } from 'bun:test';
import type Redis from 'ioredis';
import { QUEUE_NAMES } from '../../../src/config/queue.js';

// Mock the logger
mock.module('../../../src/config/logger.js', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

// Mock the DB
mock.module('../../../src/db/index.js', () => ({
  db: {},
}));

// Mock the tasks service
const mockGenerateTasksForAttack = mock(() => Promise.resolve({ tasks: [], count: 5 }));
mock.module('../../../src/services/tasks.js', () => ({
  generateTasksForAttack: mockGenerateTasksForAttack,
  reassignStaleTasks: mock(),
}));

// Mock BullMQ Worker to capture the processor function
let capturedProcessor: ((job: any) => Promise<any>) | null = null;
mock.module('bullmq', () => ({
  Worker: class MockWorker {
    constructor(_name: string, processor: any) {
      capturedProcessor = processor;
    }
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  },
  Queue: class MockQueue {
    add() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    getWaitingCount() {
      return Promise.resolve(0);
    }
    getActiveCount() {
      return Promise.resolve(0);
    }
    getFailedCount() {
      return Promise.resolve(0);
    }
    upsertJobScheduler() {
      return Promise.resolve();
    }
  },
}));

describe('Task generator worker', () => {
  test('processor generates tasks for each attack', async () => {
    const { createTaskGeneratorWorker } = await import(
      '../../../src/queue/workers/task-generator.js'
    );

    const fakeConnection = {} as Redis;
    createTaskGeneratorWorker(fakeConnection, QUEUE_NAMES.TASKS_NORMAL);

    expect(capturedProcessor).toBeDefined();

    const fakeJob = {
      id: 'gen-1',
      data: { campaignId: 1, projectId: 1, attackIds: [10, 20, 30], priority: 5 },
    };

    const result = await capturedProcessor!(fakeJob);

    expect(mockGenerateTasksForAttack).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ campaignId: 1, totalTasks: 15, skippedAttacks: 0 });
  });

  test('processor skips attacks that return errors and reports skippedAttacks', async () => {
    mockGenerateTasksForAttack.mockReset();
    mockGenerateTasksForAttack
      .mockResolvedValueOnce({ tasks: [], count: 5 })
      .mockResolvedValueOnce({ error: 'Attack not found' })
      .mockResolvedValueOnce({ tasks: [], count: 3 });

    const fakeJob = {
      id: 'gen-2',
      data: { campaignId: 2, projectId: 1, attackIds: [1, 2, 3], priority: 5 },
    };

    const result = await capturedProcessor!(fakeJob);

    expect(result).toEqual({ campaignId: 2, totalTasks: 8, skippedAttacks: 1 });
  });

  test('processor reports skippedAttacks=N when every attack fails', async () => {
    mockGenerateTasksForAttack.mockReset();
    mockGenerateTasksForAttack
      .mockResolvedValueOnce({ error: 'Attack 1 not found' })
      .mockResolvedValueOnce({ error: 'Attack 2 not found' });

    const fakeJob = {
      id: 'gen-3',
      data: { campaignId: 3, projectId: 1, attackIds: [1, 2], priority: 5 },
    };

    const result = await capturedProcessor!(fakeJob);

    expect(result).toEqual({ campaignId: 3, totalTasks: 0, skippedAttacks: 2 });
  });
});
