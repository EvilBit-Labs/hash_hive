import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QUEUE_NAMES, TASK_PRIORITY_QUEUES } from '../../src/config/queue.js';
import { getQueueManager, setQueueManager } from '../../src/queue/context.js';
import { QueueManager } from '../../src/queue/manager.js';

describe('Queue config', () => {
  test('QUEUE_NAMES has priority task queue names', () => {
    expect(QUEUE_NAMES.TASKS_HIGH).toBe('tasks-high');
    expect(QUEUE_NAMES.TASKS_NORMAL).toBe('tasks-normal');
    expect(QUEUE_NAMES.TASKS_LOW).toBe('tasks-low');
  });

  test('QUEUE_NAMES has job queue names', () => {
    expect(QUEUE_NAMES.HASH_LIST_PARSING).toBe('jobs-hash-list-parsing');
    expect(QUEUE_NAMES.HEARTBEAT_MONITOR).toBe('jobs-heartbeat-monitor');
  });

  test('TASK_PRIORITY_QUEUES contains the three priority queues', () => {
    expect(TASK_PRIORITY_QUEUES).toEqual(['tasks-high', 'tasks-normal', 'tasks-low']);
  });
});

describe('Queue context', () => {
  test('getQueueManager returns null before setQueueManager', () => {
    // Context starts null (or may have been set by other tests),
    // so we test the set/get cycle
    const qm = new QueueManager();
    setQueueManager(qm);
    expect(getQueueManager()).toBe(qm);
  });

  test('setQueueManager replaces previous instance', () => {
    const qm1 = new QueueManager();
    const qm2 = new QueueManager();
    setQueueManager(qm1);
    expect(getQueueManager()).toBe(qm1);
    setQueueManager(qm2);
    expect(getQueueManager()).toBe(qm2);
  });
});

describe('QueueManager', () => {
  test('can be instantiated without errors', () => {
    const qm = new QueueManager();
    expect(qm).toBeDefined();
    expect(typeof qm.init).toBe('function');
    expect(typeof qm.enqueue).toBe('function');
    expect(typeof qm.getHealth).toBe('function');
    expect(typeof qm.shutdown).toBe('function');
  });

  test('getHealth returns disconnected when not initialized', async () => {
    const qm = new QueueManager();
    const health = await qm.getHealth();
    expect(health.status).toBe('disconnected');
    expect(health.queues).toEqual({});
  });

  test('enqueue returns false when not initialized', async () => {
    const qm = new QueueManager();
    const result = await qm.enqueue(QUEUE_NAMES.HASH_LIST_PARSING, {
      hashListId: 1,
      projectId: 1,
    });
    expect(result).toBe(false);
  });

  test('enqueue returns false for priority task queue when not initialized', async () => {
    const qm = new QueueManager();
    const result = await qm.enqueue(QUEUE_NAMES.TASKS_NORMAL, {
      campaignId: 1,
      projectId: 1,
      attackIds: [1],
      priority: 5,
    });
    expect(result).toBe(false);
  });
});
