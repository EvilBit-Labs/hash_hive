---
name: backend-patterns
description: Backend architecture patterns, API design, database optimization, and server-side best practices optimized for HashHive's Bun + Hono + Drizzle ORM + PostgreSQL stack.
origin: ECC
---

# Backend Development Patterns

> **HashHive stack:** Bun runtime · Hono framework · Drizzle ORM · PostgreSQL · Redis + BullMQ · MinIO (S3-compatible)
> All examples target this stack. Do NOT introduce Express, Next.js API routes, Prisma, Supabase client, or Node.js-specific APIs.

Backend architecture patterns and best practices for scalable server-side applications.

## When to Activate

- Designing REST API endpoints in Hono
- Implementing repository, service, or controller layers
- Optimizing Drizzle ORM queries (N+1, indexing, connection pooling)
- Adding caching (Redis, in-memory, HTTP cache headers)
- Setting up BullMQ background jobs or async processing
- Structuring error handling and validation for Hono APIs
- Building Hono middleware (auth, logging, rate limiting)

## API Design Patterns

### RESTful API Structure

```typescript
// ✅ Resource-based URLs
GET    /api/v1/dashboard/agents           # List resources
GET    /api/v1/dashboard/agents/:id       # Get single resource
POST   /api/v1/dashboard/agents           # Create resource
PUT    /api/v1/dashboard/agents/:id       # Replace resource
PATCH  /api/v1/dashboard/agents/:id       # Update resource
DELETE /api/v1/dashboard/agents/:id       # Delete resource

// ✅ Query parameters for filtering, sorting, pagination
GET /api/v1/dashboard/agents?status=active&sort=name&limit=20&offset=0
```

### Hono Route Handler Pattern

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db";
import { agents } from "@hashhive/shared/db/schema";
import { eq } from "drizzle-orm";
import { createAgentSchema } from "@hashhive/shared/schemas";

const agentsRouter = new Hono();

// GET /agents — list
agentsRouter.get("/", async (c) => {
  const projectId = c.get("currentUser").projectId;

  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.projectId, projectId));

  return c.json({ success: true, data: rows });
});

// POST /agents — create
agentsRouter.post("/", zValidator("json", createAgentSchema), async (c) => {
  const body = c.req.valid("json");
  const projectId = c.get("currentUser").projectId;

  const [created] = await db
    .insert(agents)
    .values({ ...body, projectId })
    .returning();

  return c.json({ success: true, data: created }, 201);
});

export { agentsRouter };
```

### Repository Pattern

```typescript
// Abstract data access logic
interface AgentRepository {
  findAll(projectId: string, filters?: AgentFilters): Promise<Agent[]>;
  findById(id: string): Promise<Agent | null>;
  create(data: CreateAgentDto): Promise<Agent>;
  update(id: string, data: UpdateAgentDto): Promise<Agent>;
  delete(id: string): Promise<void>;
}

class DrizzleAgentRepository implements AgentRepository {
  async findAll(projectId: string, filters?: AgentFilters): Promise<Agent[]> {
    const conditions = [eq(agents.projectId, projectId)];

    if (filters?.status) {
      conditions.push(eq(agents.status, filters.status));
    }

    return db
      .select()
      .from(agents)
      .where(and(...conditions))
      .limit(filters?.limit ?? 100);
  }

  async findById(id: string): Promise<Agent | null> {
    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);

    return row ?? null;
  }

  // Other methods...
}
```

### Service Layer Pattern

```typescript
// Business logic separated from data access — only add a service layer
// when Hono route handlers become too complex (>50 lines of logic).
class TaskDistributionService {
  constructor(private agentRepo: AgentRepository) {}

  async assignNextTask(agentId: string): Promise<Task | null> {
    const agent = await this.agentRepo.findById(agentId);

    if (!agent || agent.status !== "active") {
      throw new ApiError(403, "Agent is not eligible for tasks");
    }

    // Business logic: select task matching agent capabilities
    const task = await this.selectCompatibleTask(agent);
    return task;
  }

  private async selectCompatibleTask(agent: Agent): Promise<Task | null> {
    // Implementation
    return null;
  }
}
```

### Hono Middleware Pattern

```typescript
import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { ApiError } from "../errors";

// Auth middleware — reads JWT from HttpOnly cookie
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, "session");

  if (!token) {
    throw new ApiError(401, "Missing session token");
  }

  try {
    const payload = await verify(token, process.env.JWT_SECRET!);
    c.set("currentUser", payload);
    await next();
  } catch {
    throw new ApiError(401, "Invalid or expired session");
  }
};

// RBAC middleware — role check
export const requireRole = (
  role: "admin" | "contributor" | "viewer",
): MiddlewareHandler => {
  return async (c, next) => {
    const user = c.get("currentUser");

    if (!hasRole(user, role)) {
      throw new ApiError(403, "Insufficient permissions");
    }

    await next();
  };
};

// Usage in router
app.use("/api/v1/dashboard/*", requireAuth);
app.post("/api/v1/dashboard/campaigns", requireRole("contributor"), handler);
```

## Database Patterns (Drizzle ORM)

### Query Optimization

```typescript
import { db } from "../db";
import { hashItems, hashLists } from "@hashhive/shared/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";

// ✅ GOOD: Select only needed columns
const items = await db
  .select({
    id: hashItems.id,
    hashValue: hashItems.hashValue,
    plaintext: hashItems.plaintext,
  })
  .from(hashItems)
  .where(and(eq(hashItems.hashListId, listId), isNotNull(hashItems.plaintext)))
  .limit(50);

// ❌ BAD: Select everything when you only need a few columns
const items = await db.select().from(hashItems);
```

### N+1 Query Prevention

```typescript
// ❌ BAD: N+1 query problem
const campaigns = await db.select().from(campaigns);
for (const campaign of campaigns) {
  // N additional queries
  campaign.attacks = await db
    .select()
    .from(attacks)
    .where(eq(attacks.campaignId, campaign.id));
}

// ✅ GOOD: Join or batch fetch in a single query
const results = await db
  .select({
    campaign: campaigns,
    attack: attacks,
  })
  .from(campaigns)
  .leftJoin(attacks, eq(attacks.campaignId, campaigns.id))
  .where(eq(campaigns.projectId, projectId));

// Group in application code
const campaignMap = new Map<
  string,
  typeof campaigns.$inferSelect & { attacks: (typeof attacks.$inferSelect)[] }
>();
for (const { campaign, attack } of results) {
  if (!campaignMap.has(campaign.id)) {
    campaignMap.set(campaign.id, { ...campaign, attacks: [] });
  }
  if (attack) {
    campaignMap.get(campaign.id)!.attacks.push(attack);
  }
}
```

### Transaction Pattern

```typescript
import { db } from "../db";

// Drizzle transaction — all statements share the same connection
async function createCampaignWithAttack(
  campaignData: NewCampaign,
  attackData: NewAttack,
) {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values(campaignData)
      .returning();

    const [attack] = await tx
      .insert(attacks)
      .values({ ...attackData, campaignId: campaign.id })
      .returning();

    return { campaign, attack };
  });
}
```

### Upsert / Conflict Handling

```typescript
// hash_items has unique constraint on (hashListId, hashValue)
// Use onConflictDoUpdate for crack result attribution
await db
  .insert(hashItems)
  .values({
    hashListId,
    hashValue,
    plaintext,
    crackedAt: new Date(),
  })
  .onConflictDoUpdate({
    target: [hashItems.hashListId, hashItems.hashValue],
    set: {
      plaintext,
      crackedAt: new Date(),
    },
  });
```

### Bulk Insert (Agent Batch Submissions)

```typescript
// Use Drizzle batch insert for bulk hash submissions from agents
// Avoid looping individual inserts — send a single statement
const CHUNK_SIZE = 500;

async function bulkInsertHashResults(
  results: { hashValue: string; plaintext: string }[],
  hashListId: string,
) {
  for (let i = 0; i < results.length; i += CHUNK_SIZE) {
    const chunk = results.slice(i, i + CHUNK_SIZE);

    await db
      .insert(hashItems)
      .values(chunk.map((r) => ({ ...r, hashListId })))
      .onConflictDoUpdate({
        target: [hashItems.hashListId, hashItems.hashValue],
        set: { plaintext: sql`excluded.plaintext`, crackedAt: new Date() },
      });
  }
}
```

## Caching Strategies

### Redis Caching Layer

```typescript
import { redis } from "../redis";

class CachedAgentRepository implements AgentRepository {
  constructor(private baseRepo: AgentRepository) {}

  async findById(id: string): Promise<Agent | null> {
    const cacheKey = `agent:${id}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached) as Agent;
    }

    const agent = await this.baseRepo.findById(id);

    if (agent) {
      await redis.setex(cacheKey, 60, JSON.stringify(agent)); // 60s TTL
    }

    return agent;
  }

  async invalidate(id: string): Promise<void> {
    await redis.del(`agent:${id}`);
  }
}
```

### Cache-Aside Pattern

```typescript
async function getAgentWithCache(id: string): Promise<Agent> {
  const cacheKey = `agent:${id}`;
  const cached = await redis.get(cacheKey);

  if (cached) return JSON.parse(cached) as Agent;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent) throw new ApiError(404, "Agent not found");

  await redis.setex(cacheKey, 60, JSON.stringify(agent));

  return agent;
}
```

## Error Handling Patterns

### Hono Error Handler

```typescript
import type { ErrorHandler } from "hono";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly isOperational = true,
  ) {
    super(message);
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export const errorHandler: ErrorHandler = (error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { success: false, error: error.message },
      error.statusCode as never,
    );
  }

  if (error instanceof ZodError) {
    return c.json(
      { success: false, error: "Validation failed", details: error.errors },
      400,
    );
  }

  console.error("Unexpected error:", error);

  return c.json({ success: false, error: "Internal server error" }, 500);
};

// Register on app instance
app.onError(errorHandler);
```

### Route-Level Error Handling

```typescript
agentsRouter.get("/:id", async (c) => {
  const { id } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent) {
    throw new ApiError(404, `Agent ${id} not found`);
  }

  return c.json({ success: true, data: agent });
});
```

### Retry with Exponential Backoff

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await Bun.sleep(delayMs);
      }
    }
  }

  throw lastError!;
}
```

## Authentication & Authorization

### JWT Validation (Hono)

```typescript
import { verify, sign } from "hono/jwt";

interface SessionPayload {
  userId: string;
  projectId: string;
  email: string;
  roles: ("admin" | "contributor" | "viewer")[];
}

export async function createSessionToken(
  payload: SessionPayload,
): Promise<string> {
  return sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 }, // 8h
    process.env.JWT_SECRET!,
  );
}

export async function verifySessionToken(
  token: string,
): Promise<SessionPayload> {
  try {
    return (await verify(token, process.env.JWT_SECRET!)) as SessionPayload;
  } catch {
    throw new ApiError(401, "Invalid or expired session");
  }
}
```

### Role-Based Access Control (HashHive)

```typescript
// Roles: admin > contributor > viewer
// Components reference Permission constants, never role strings directly.

const ROLE_HIERARCHY: Record<string, number> = {
  admin: 3,
  contributor: 2,
  viewer: 1,
};

export function hasRole(
  user: SessionPayload,
  requiredRole: "admin" | "contributor" | "viewer",
): boolean {
  return user.roles.some(
    (r) => (ROLE_HIERARCHY[r] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0),
  );
}

// Two RBAC middleware variants (see src/middleware/rbac.ts):
// - requireRole() — reads projectId from JWT (most dashboard routes)
// - requireParamProjectRole() — reads projectId from URL param (project management routes)
```

## Rate Limiting

### Redis-Backed Rate Limiter (Production-Ready)

```typescript
import { redis } from "../redis";
import type { MiddlewareHandler } from "hono";

export function rateLimiter(
  maxRequests: number,
  windowSeconds: number,
): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for") ?? "unknown";
    const key = `ratelimit:${ip}`;

    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }

    if (count > maxRequests) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    await next();
  };
}

// Usage
app.use("/api/v1/agent/*", rateLimiter(300, 60)); // 300 req/min for agents
app.use("/api/v1/dashboard/*", rateLimiter(100, 60)); // 100 req/min for dashboard
```

## Background Jobs & Queues (BullMQ)

### BullMQ Worker Pattern

```typescript
import { Queue, Worker, type Job } from "bullmq";
import { redis } from "../redis";

// Define job payload types
interface HashListParseJob {
  hashListId: string;
  storagePath: string;
}

// Create queue
export const hashListQueue = new Queue<HashListParseJob>("hash-list-parse", {
  connection: redis,
});

// Create worker
export const hashListWorker = new Worker<HashListParseJob>(
  "hash-list-parse",
  async (job: Job<HashListParseJob>) => {
    const { hashListId, storagePath } = job.data;

    await job.updateProgress(0);

    // Stream from MinIO, parse, bulk-insert into hash_items
    await parseAndInsertHashList(hashListId, storagePath, async (pct) => {
      await job.updateProgress(pct);
    });
  },
  { connection: redis, concurrency: 2 },
);

hashListWorker.on("failed", (job, error) => {
  console.error(`[hash-list-parse] job ${job?.id} failed:`, error);
});

// Enqueue from a route handler
agentsRouter.post(
  "/hash-lists/:id/parse",
  requireRole("contributor"),
  async (c) => {
    const { id } = c.req.param();

    await hashListQueue.add("parse", {
      hashListId: id,
      storagePath: `hash-lists/${id}`,
    });

    return c.json({ success: true, message: "Parse job queued" });
  },
);
```

## Logging & Monitoring

### Structured Logging

```typescript
interface LogContext {
  userId?: string;
  agentId?: string;
  requestId?: string;
  method?: string;
  path?: string;
  durationMs?: number;
  [key: string]: unknown;
}

class Logger {
  private log(
    level: "info" | "warn" | "error",
    message: string,
    context?: LogContext,
  ) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...context,
      }),
    );
  }

  info(message: string, context?: LogContext) {
    this.log("info", message, context);
  }
  warn(message: string, context?: LogContext) {
    this.log("warn", message, context);
  }

  error(message: string, error: Error, context?: LogContext) {
    this.log("error", message, {
      ...context,
      error: error.message,
      stack: error.stack,
    });
  }
}

export const logger = new Logger();
```

### Request Logging Middleware

```typescript
import type { MiddlewareHandler } from "hono";

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  await next();

  logger.info("request completed", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
  });
};
```

## MinIO / Storage Patterns

### Streaming Upload (No Full-File Buffering)

```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY!,
    secretAccessKey: process.env.MINIO_SECRET_KEY!,
  },
  forcePathStyle: true,
});

// Stream directly to MinIO — never buffer the full file in memory
export async function uploadChunk(
  key: string,
  stream: ReadableStream,
  contentLength: number,
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.MINIO_BUCKET!,
      Key: key,
      Body: stream,
      ContentLength: contentLength,
    }),
  );
}
```

**Remember**: Thin Hono route handlers (validate → query/service → respond). Only introduce a service layer when handlers exceed ~50 lines of logic. Keep files under 800 lines. One direction: Drizzle schema → drizzle-zod → Zod schemas → TypeScript types.
