/**
 * Agent API contract tests.
 *
 * These validate that route handlers return response shapes matching
 * the OpenAPI spec (agent-api.yaml). They use the Hono test client
 * (app.request) and mock the database layer to avoid needing a running
 * database.
 *
 * The middleware validates pre-shared tokens by querying the agents table.
 * We mock the DB to return a valid agent for our test token.
 */
import { describe, expect, it, mock } from 'bun:test';

// Mock the DB so requireAgentToken middleware can resolve the pre-shared token.
// Service modules (tasks, campaigns, events) are also mocked to prevent real
// modules from entering bun's shared module cache, which would break mock
// isolation for other test files (e.g., campaign-transition.test.ts).
const TEST_AGENT_TOKEN = 'test-agent-preshared-token';

// Snake_case row kept as a reference for building the camelCase mock below.
// The actual snake→camelCase mapping is validated in tasks.test.ts.
const mockSnakeCaseTaskRow = {
  id: 42,
  attack_id: 7,
  campaign_id: 3,
  agent_id: 1,
  status: 'assigned',
  work_range: { start: 0, end: 10000000 },
  progress: {},
  result_stats: {},
  required_capabilities: {},
  assigned_at: '2026-03-24T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  failure_reason: null,
  created_at: '2026-03-24T00:00:00.000Z',
  updated_at: '2026-03-24T00:00:00.000Z',
};

const mockAgent = {
  id: 1,
  projectId: 1,
  status: 'online',
  capabilities: {},
};

const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      limit: mock(() => Promise.resolve([mockAgent])),
    })),
  })),
}));

const mockExecute = mock(() => Promise.resolve([mockSnakeCaseTaskRow]));

mock.module('../../src/services/agents.js', () => ({
  processHeartbeat: mock(() => Promise.resolve({ hasHighPriorityTasks: false })),
  logAgentError: mock(() => Promise.resolve()),
}));

// Mock events and tasks to prevent real modules from entering the shared bun
// module cache (which leaks across test files via mock.module merge behavior).
// campaigns.js is NOT mocked here — its mock.module overrides leak into other
// files' real campaigns.js via ESM export merging, replacing resolveGenerationStrategy.
mock.module('../../src/services/events.js', () => ({
  emitCrackResult: mock(),
  emitTaskUpdate: mock(),
  emitCampaignStatus: mock(),
}));

// Mock tasks.js so the real module is never cached — the snake_case→camelCase
// mapping is validated in tasks.test.ts; here we only test the route contract.
// This also removes the need to mock campaigns.js (which tasks.js imported).
const mockCamelCaseTask = {
  id: mockSnakeCaseTaskRow.id,
  attackId: mockSnakeCaseTaskRow.attack_id,
  campaignId: mockSnakeCaseTaskRow.campaign_id,
  agentId: mockSnakeCaseTaskRow.agent_id,
  status: mockSnakeCaseTaskRow.status,
  workRange: mockSnakeCaseTaskRow.work_range,
  progress: mockSnakeCaseTaskRow.progress,
  resultStats: mockSnakeCaseTaskRow.result_stats,
  requiredCapabilities: mockSnakeCaseTaskRow.required_capabilities,
  assignedAt: mockSnakeCaseTaskRow.assigned_at,
  startedAt: mockSnakeCaseTaskRow.started_at,
  completedAt: mockSnakeCaseTaskRow.completed_at,
  failureReason: mockSnakeCaseTaskRow.failure_reason,
  createdAt: mockSnakeCaseTaskRow.created_at,
  updatedAt: mockSnakeCaseTaskRow.updated_at,
};

mock.module('../../src/services/tasks.js', () => ({
  assignNextTask: mock(() => Promise.resolve(mockCamelCaseTask)),
  updateTaskProgress: mock(() => Promise.resolve({ acknowledged: true })),
  handleTaskFailure: mock(() => Promise.resolve({ retried: false })),
  generateTasksForAttack: mock(() => Promise.resolve({ tasks: [], count: 0 })),
  reassignStaleTasks: mock(() => Promise.resolve([])),
  getTaskById: mock(() => Promise.resolve(null)),
  listTasks: mock(() => Promise.resolve([])),
}));

mock.module('../../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    execute: mockExecute,
  },
  client: {},
}));

import { app } from '../../src/index.js';
import { agentToken } from '../fixtures.js';

const AGENT_BASE = '/api/v1/agent';

// ─── POST /sessions — removed (should 404) ──────────────────────────

describe('Agent API: POST /sessions (removed)', () => {
  it('should return 404 since session endpoint no longer exists', async () => {
    const res = await app.request(`${AGENT_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' }),
    });

    expect(res.status).toBe(404);
  });
});

// ─── POST /heartbeat — Agent Heartbeat ──────────────────────────────

describe('Agent API: POST /heartbeat', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body['error']).toBeDefined();
    expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID');
  });

  it('should return 400 for invalid heartbeat status enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN);
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'invalid-status' }),
    });

    expect(res.status).toBe(400);
  });
});

// ─── POST /tasks/next — Request Next Task ───────────────────────────

describe('Agent API: POST /tasks/next', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/tasks/next`, {
      method: 'POST',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body['error']).toBeDefined();
  });

  it('returns camelCase task descriptor when task is available', async () => {
    const token = agentToken(TEST_AGENT_TOKEN);
    const res = await app.request(`${AGENT_BASE}/tasks/next`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const task = body['task'] as Record<string, unknown>;

    // Task should be present
    expect(task).not.toBeNull();

    // camelCase keys should be defined
    expect(task['attackId']).toBeDefined();
    expect(task['campaignId']).toBeDefined();
    expect(task['workRange']).toBeDefined();

    // snake_case keys should be absent
    expect(task['attack_id']).toBeUndefined();
    expect(task['campaign_id']).toBeUndefined();
    expect(task['work_range']).toBeUndefined();
  });
});

// ─── POST /tasks/:id/report — Report Task Progress ─────────────────

describe('Agent API: POST /tasks/:id/report', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/tasks/1/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });

    expect(res.status).toBe(401);
  });

  it('should return 400 for invalid status enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN);
    const res = await app.request(`${AGENT_BASE}/tasks/1/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'not-a-valid-status' }),
    });

    expect(res.status).toBe(400);
  });
});

// ─── POST /errors — Report Agent Error ──────────────────────────────

describe('Agent API: POST /errors', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: 'error', message: 'test error' }),
    });

    expect(res.status).toBe(401);
  });

  it('should return 400 for missing required fields', async () => {
    const token = agentToken(TEST_AGENT_TOKEN);
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('should return 400 for invalid severity enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN);
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ severity: 'invalid', message: 'test' }),
    });

    expect(res.status).toBe(400);
  });
});
