---
name: coding-standards
description: Coding standards, best practices, and patterns for the HashHive TypeScript + Biome + bun:test stack.
origin: ECC
---

# Coding Standards & Best Practices

> **HashHive stack note**: This skill is optimized for the HashHive TypeScript + Biome stack.
> Toolchain: **Biome** (lint + format, not ESLint/Prettier), **bun:test** (not Jest/Vitest),
> **Hono** (not Express), **Drizzle ORM** (not Prisma), **React 19**, **Zod** (drizzle-zod generates schemas).

## When to Activate

- Starting a new module or feature
- Reviewing code for quality and maintainability
- Refactoring existing code to follow conventions
- Enforcing naming, formatting, or structural consistency
- Setting up linting, formatting, or type-checking rules
- Onboarding new contributors to coding conventions

## Code Quality Principles

### 1. Readability First

- Code is read more than written
- Clear variable and function names
- Self-documenting code preferred over comments
- Consistent formatting (enforced by Biome)

### 2. KISS (Keep It Simple, Stupid)

- Simplest solution that works
- Avoid over-engineering
- No premature optimization
- Easy to understand > clever code

### 3. DRY (Don't Repeat Yourself)

- Extract common logic into functions
- Create reusable components
- Share utilities across modules
- Avoid copy-paste programming

### 4. YAGNI (You Aren't Gonna Need It)

- Don't build features before they're needed
- Avoid speculative generality
- Add complexity only when required
- Start simple, refactor when needed

## TypeScript/JavaScript Standards

### Variable Naming

```typescript
// GOOD: Descriptive names
const hashSearchQuery = "md5";
const isAgentAuthenticated = true;
const totalCrackedHashes = 1000;

// BAD: Unclear names
const q = "md5";
const flag = true;
const x = 1000;
```

### Function Naming

```typescript
// GOOD: Verb-noun pattern
async function fetchAgentById(agentId: string) {}
function calculateKeyspaceOffset(start: number, end: number) {}
function isValidHashMode(mode: number): boolean {}

// BAD: Unclear or noun-only
async function agent(id: string) {}
function keyspace(a, b) {}
function hashMode(m) {}
```

### Immutability Pattern (CRITICAL)

```typescript
// ALWAYS use spread operator — never mutate existing objects
const updatedAgent = {
  ...agent,
  status: "active",
};

const updatedItems = [...hashItems, newItem];

// NEVER mutate directly
agent.status = "active"; // BAD
hashItems.push(newItem); // BAD
```

### TypeScript Strict Mode

HashHive runs with `strict: true`. All code must satisfy the strict compiler:

```typescript
// GOOD: Explicit types, no implicit any
function parseHashMode(raw: unknown): number {
  if (typeof raw !== "number") throw new Error("Invalid hash mode");
  return raw;
}

// BAD: Implicit any, missing return type
function parseHashMode(raw) {
  return raw;
}

// GOOD: Nullability handled explicitly
function getAgentName(agent: Agent | null): string {
  return agent?.name ?? "Unknown";
}
```

### Error Handling

```typescript
// GOOD: Comprehensive error handling
async function fetchHashList(id: string) {
  try {
    const result = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, id));

    if (result.length === 0) {
      throw new Error(`Hash list not found: ${id}`);
    }

    return result[0];
  } catch (error) {
    console.error("fetchHashList failed:", { id, error });
    throw new Error("Failed to fetch hash list");
  }
}

// BAD: No error handling
async function fetchHashList(id) {
  const result = await db.select().from(hashLists).where(eq(hashLists.id, id));
  return result[0];
}
```

### Async/Await Best Practices

```typescript
// GOOD: Parallel execution when possible
const [agents, campaigns, stats] = await Promise.all([
  fetchAgents(),
  fetchCampaigns(),
  fetchDashboardStats(),
]);

// BAD: Sequential when unnecessary
const agents = await fetchAgents();
const campaigns = await fetchCampaigns();
const stats = await fetchDashboardStats();
```

### Type Safety

```typescript
// GOOD: Proper types derived from Drizzle schema via drizzle-zod
import type { Agent } from "@hashhive/shared";

function getAgent(id: string): Promise<Agent> {
  // Implementation
}

// BAD: Using 'any'
function getAgent(id: any): Promise<any> {
  // Implementation
}
```

## Biome Configuration

HashHive uses **Biome** for both linting and formatting. Do not introduce ESLint or Prettier.

### Running Biome

```bash
# Lint and format check
bun lint            # Lint all code with Biome
bun format          # Format all code with Biome

# Auto-fix (safe fixes only — always run type-check after)
bunx biome check --write src/

# Unsafe fixes (run bun type-check immediately after)
bunx biome check --write --unsafe src/
```

### Biome Suppression

When a Biome rule must be suppressed, place the comment correctly:

```typescript
// GOOD: Suppress on the line above the offending code
// biome-ignore lint/suspicious/noExplicitAny: legacy API shape
const raw: any = JSON.parse(body)

// GOOD: Inside JSX tag, above the attribute (not before the tag)
<Component
  // biome-ignore lint/a11y/noAutofocus: intentional focus management
  autoFocus={true}
/>

// BAD: Before a JSX tag opening
// biome-ignore lint/a11y/noAutofocus: ...
<Component autoFocus={true} />
```

### Biome Formatting Rules

Biome enforces these defaults in HashHive:

- No semicolons (unless configured otherwise — check `biome.json`)
- Single quotes
- 2-space indentation
- Trailing commas in multi-line expressions

Follow whatever `biome.json` at the workspace root specifies — do not override per-file.

## Drizzle ORM Patterns

HashHive uses Drizzle ORM with PostgreSQL. Schema lives in `packages/shared/src/db/schema.ts`.

```typescript
import { db } from "../db";
import { agents, tasks } from "@hashhive/shared";
import { eq, and, desc } from "drizzle-orm";

// GOOD: Select only needed columns
const agentList = await db
  .select({ id: agents.id, name: agents.name, status: agents.status })
  .from(agents)
  .where(eq(agents.projectId, projectId))
  .orderBy(desc(agents.lastSeenAt))
  .limit(50);

// BAD: Select everything when only a few fields are needed
const agentList = await db.select().from(agents);

// GOOD: Upsert with onConflictDoUpdate (e.g., crack result attribution)
await db
  .insert(hashItems)
  .values({ hashListId, hashValue, plaintext })
  .onConflictDoUpdate({
    target: [hashItems.hashListId, hashItems.hashValue],
    set: { plaintext, crackedAt: new Date() },
  });
```

### Schema Flow (single source of truth)

```
Drizzle tables (schema.ts)
  → drizzle-zod (auto-generated Zod schemas)
  → z.infer (TypeScript types)
```

Never duplicate type definitions. If you need a type, derive it:

```typescript
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { agents } from "./schema";

export const insertAgentSchema = createInsertSchema(agents);
export const selectAgentSchema = createSelectSchema(agents);
export type InsertAgent = typeof insertAgentSchema._type;
export type Agent = typeof selectAgentSchema._type;
```

## Hono Route Handler Patterns

HashHive uses Hono on Bun. Route handlers should be thin — validate input, query DB, return response.

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db";
import { agents } from "@hashhive/shared";

const agentRoutes = new Hono();

// GOOD: Thin handler with Zod validation
agentRoutes.post(
  "/heartbeat",
  zValidator("json", heartbeatSchema),
  async (c) => {
    const body = c.req.valid("json");
    const currentAgent = c.get("agent");

    await db
      .update(agents)
      .set({ lastSeenAt: new Date(), ...body })
      .where(eq(agents.id, currentAgent.id));

    return c.json({ success: true });
  },
);

// GOOD: Consistent error response shape
agentRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await db.select().from(agents).where(eq(agents.id, id));

  if (result.length === 0) {
    return c.json({ success: false, error: "Agent not found" }, 404);
  }

  return c.json({ success: true, data: result[0] });
});
```

### API Response Format

```typescript
// Consistent envelope for all API responses
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    total: number;
    page: number;
    limit: number;
  };
}

// Success
return c.json({ success: true, data: agents, meta: { total, page, limit } });

// Error
return c.json({ success: false, error: "Invalid request" }, 400);
```

## Zod Validation Patterns

```typescript
import { z } from "zod";

// GOOD: Schema validation at system boundaries
const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  projectId: z.string().uuid(),
  hashListId: z.string().uuid(),
});

// In Hono handler — use zValidator middleware, not manual parse
agentRoutes.post("/", zValidator("json", createCampaignSchema), async (c) => {
  const body = c.req.valid("json"); // fully typed and validated
  // ...
});

// When manual parse is needed
try {
  const validated = createCampaignSchema.parse(body);
} catch (error) {
  if (error instanceof z.ZodError) {
    return c.json(
      { success: false, error: "Validation failed", details: error.errors },
      400,
    );
  }
  throw error;
}
```

## React Best Practices (React 19)

### Component Structure

```typescript
// GOOD: Functional component with types
interface AgentCardProps {
  agent: Agent
  onSelect: (id: string) => void
  isSelected?: boolean
}

export function AgentCard({
  agent,
  onSelect,
  isSelected = false
}: AgentCardProps) {
  return (
    <div
      onClick={() => onSelect(agent.id)}
      className={`card ${isSelected ? 'card--selected' : ''}`}
    >
      <span>{agent.name}</span>
    </div>
  )
}

// BAD: No types, unclear structure
export function AgentCard(props) {
  return <div onClick={() => props.onSelect(props.agent.id)}>{props.agent.name}</div>
}
```

### Custom Hooks (TanStack Query wrappers)

```typescript
// GOOD: TanStack Query wrapper hook
import { useQuery } from "@tanstack/react-query";

export function useAgent(agentId: string) {
  return useQuery({
    queryKey: ["agents", agentId],
    queryFn: () => fetchAgent(agentId),
    enabled: Boolean(agentId),
  });
}

// GOOD: TanStack Query mutation with cache invalidation
export function useUpdateAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateAgentInput) => updateAgent(data),
    onSuccess: (_data, variables) => {
      // Use variables for cache keys — not local state (can be stale)
      queryClient.invalidateQueries({ queryKey: ["agents", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
```

### State Management

```typescript
// GOOD: Functional update for state based on previous state
const [count, setCount] = useState(0);
setCount((prev) => prev + 1);

// BAD: Direct state reference (can be stale in async scenarios)
setCount(count + 1);
```

### Conditional Rendering

```typescript
// GOOD: Clear conditional rendering
{isLoading && <Spinner />}
{error && <ErrorMessage error={error} />}
{data && <DataDisplay data={data} />}

// BAD: Ternary hell
{isLoading ? <Spinner /> : error ? <ErrorMessage error={error} /> : data ? <DataDisplay data={data} /> : null}
```

### RBAC in Components

```typescript
// GOOD: Use Permission constants, never role strings
import { Permission } from '@/lib/permissions'
import { usePermission } from '@/hooks/usePermission'

export function CampaignActions() {
  const canCreate = usePermission(Permission.CAMPAIGN_CREATE)

  return (
    <div>
      {canCreate && <Button onClick={onCreate}>New Campaign</Button>}
    </div>
  )
}

// BAD: Hardcoding role strings
{currentUser.role === 'admin' && <Button>New Campaign</Button>}
```

## Testing Standards (bun:test)

HashHive uses **bun:test** exclusively. Do not use Jest or Vitest.

### Test Structure (AAA Pattern)

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("calculateKeyspaceChunk", () => {
  test("splits keyspace evenly across agents", () => {
    // Arrange
    const keyspace = 1_000_000;
    const agentCount = 4;

    // Act
    const chunks = calculateKeyspaceChunk(keyspace, agentCount);

    // Assert
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toEqual({ start: 0, end: 249_999 });
  });
});
```

### Test Naming

```typescript
// GOOD: Descriptive test names
test("returns empty array when no agents are online", () => {});
test("throws error when hash list is missing", () => {});
test("assigns task to agent with lowest queue depth", () => {});

// BAD: Vague test names
test("works", () => {});
test("test agent", () => {});
```

### Mocking in bun:test

```typescript
import { mock, spyOn } from "bun:test";

// Mock a module
mock.module("../db", () => ({
  db: {
    select: mock(() => ({ from: mock(() => ({ where: mock(() => []) })) })),
  },
}));

// Spy on a function
const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

// Restore after test
afterEach(() => {
  consoleSpy.mockRestore();
});
```

### Pure Function Extraction for Testability

For DB-dependent logic, extract the core algorithm as a pure function and test it directly:

```typescript
// GOOD: Pure function is easy to test without DB mocking
export function validateAttackDag(attacks: Attack[]): ValidationResult {
  // DAG cycle detection logic — no DB calls
}

// Test the pure function directly
test("detects circular attack dependencies", () => {
  const attacks = buildCircularAttackFixture();
  const result = validateAttackDag(attacks);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain("Circular dependency detected");
});
```

### Hot Paths to Test First

- Hash submission ingestion (bulk insert, conflict handling)
- Work unit distribution (keyspace partitioning, assignment logic)
- Agent heartbeat processing (timeout detection, status transitions)

## File Organization

### HashHive Monorepo Structure

```
packages/
├── backend/src/
│   ├── routes/        # Hono route handlers by domain
│   │   ├── agent/     # /api/v1/agent/*
│   │   └── dashboard/ # /api/v1/dashboard/*
│   ├── db/            # Drizzle client setup
│   ├── middleware/    # Auth, RBAC, logging
│   └── services/      # Business logic (only when handlers become complex)
├── frontend/src/
│   ├── components/
│   │   ├── ui/        # shadcn/ui base components
│   │   └── features/  # Feature-specific components
│   ├── pages/         # Route-level page components
│   ├── hooks/         # TanStack Query wrappers
│   ├── lib/           # Utilities and API client config
│   └── stores/        # Zustand client-side UI state
└── shared/src/
    ├── db/schema.ts   # Drizzle table definitions (source of truth)
    ├── schemas/       # Zod schemas (drizzle-zod + custom)
    └── types/         # Inferred types (z.infer exports)
```

### File Naming

```
routes/agents.ts              # camelCase for route files
components/AgentCard.tsx      # PascalCase for components
hooks/useAgentStatus.ts       # camelCase with 'use' prefix
lib/formatHashRate.ts         # camelCase for utilities
```

### File Size Guidelines

- Target: 200–400 lines per file
- Hard limit: 800 lines
- Extract utilities when a file grows beyond this

## Comments & Documentation

### When to Comment

```typescript
// GOOD: Explain WHY, not WHAT
// Dynamic import breaks circular dependency between campaigns and tasks services
const { generateTasks } = await import("./tasks.js");

// Exponential backoff to avoid hammering the DB during bulk submissions
const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);

// BAD: Stating the obvious
// Increment counter by 1
count++;
```

### JSDoc for Public APIs

```typescript
/**
 * Partitions a keyspace into equally-sized chunks for task distribution.
 *
 * @param totalKeyspace - Total number of candidates in the keyspace
 * @param chunkCount - Number of chunks to produce
 * @returns Array of non-overlapping [start, end] ranges
 * @throws {RangeError} If chunkCount is zero or negative
 */
export function partitionKeyspace(
  totalKeyspace: number,
  chunkCount: number,
): Array<{ start: number; end: number }> {
  // Implementation
}
```

## Performance Best Practices

### Memoization (React)

```typescript
import { useMemo, useCallback } from "react";

// GOOD: Memoize expensive computations
const sortedAgents = useMemo(() => {
  return [...agents].sort((a, b) => b.hashRate - a.hashRate);
}, [agents]);

// GOOD: Memoize callbacks passed as props
const handleAgentSelect = useCallback((id: string) => {
  setSelectedAgentId(id);
}, []);
```

### Lazy Loading

```typescript
import { lazy, Suspense } from 'react'

// GOOD: Lazy load heavy components
const CrackResultsChart = lazy(() => import('./CrackResultsChart'))

export function Dashboard() {
  return (
    <Suspense fallback={<Spinner />}>
      <CrackResultsChart />
    </Suspense>
  )
}
```

### Streaming & Large Files

HashHive handles wordlists and hash lists exceeding 100 GB. Never buffer full files in memory:

```typescript
// GOOD: Stream large files to/from MinIO
const stream = await minioClient.getObject(bucketName, objectName);
for await (const chunk of stream) {
  await processChunk(chunk);
}

// BAD: Full file in memory
const buffer = await minioClient.getObject(bucketName, objectName);
const content = buffer.toString(); // OOM on large files
```

## Code Smell Detection

Watch for these anti-patterns:

### 1. Long Functions

```typescript
// BAD: Function > 50 lines
function processHashSubmission() {
  // 100+ lines
}

// GOOD: Split into focused functions
async function processHashSubmission(submission: HashSubmission) {
  const validated = validateSubmission(submission);
  const attributed = await attributeToHashList(validated);
  return await persistCrackResults(attributed);
}
```

### 2. Deep Nesting

```typescript
// BAD: 5+ levels of nesting
if (agent) {
  if (agent.isActive) {
    if (task) {
      if (task.isAssigned) {
        if (hasCapability) {
          // Do something
        }
      }
    }
  }
}

// GOOD: Early returns
if (!agent) return;
if (!agent.isActive) return;
if (!task) return;
if (!task.isAssigned) return;
if (!hasCapability) return;

// Do something
```

### 3. Magic Numbers

```typescript
// BAD: Unexplained numbers
if (retryCount > 3) {
}
setTimeout(callback, 500);
const chunkSize = 67108864;

// GOOD: Named constants
const MAX_RETRIES = 3;
const DEBOUNCE_DELAY_MS = 500;
const UPLOAD_CHUNK_SIZE_BYTES = 64 * 1024 * 1024; // 64 MB

if (retryCount > MAX_RETRIES) {
}
setTimeout(callback, DEBOUNCE_DELAY_MS);
```

### 4. Mutation in Reducers / State Updates

```typescript
// BAD: Mutating state
state.agents.push(newAgent);
state.campaign.status = "running";

// GOOD: Return new state
return { ...state, agents: [...state.agents, newAgent] };
return { ...state, campaign: { ...state.campaign, status: "running" } };
```

**Remember**: Code quality is not negotiable. Clear, maintainable, immutable code enables rapid development and confident refactoring.
