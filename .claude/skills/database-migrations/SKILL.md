---
name: database-migrations
description: Database migration patterns for HashHive using PostgreSQL + Drizzle ORM. Schema changes, data migrations, rollbacks, and zero-downtime deployments.
origin: ECC (optimized for HashHive)
---

# Database Migration Patterns

> **HashHive context:** Schema defined in `shared/src/db/schema.ts` (Drizzle ORM). Commands: `bun --filter backend db:generate` (create migration), `bun --filter backend db:migrate` (apply), `bun --filter backend db:studio` (inspect). Drizzle Kit generates SQL migrations from schema diffs.

Safe, reversible database schema changes for production systems.

## When to Activate

- Creating or altering database tables
- Adding/removing columns or indexes
- Running data migrations (backfill, transform)
- Planning zero-downtime schema changes
- Setting up migration tooling for a new project

## Core Principles

1. **Every change is a migration** — never alter production databases manually
2. **Migrations are forward-only in production** — rollbacks use new forward migrations
3. **Schema and data migrations are separate** — never mix DDL and DML in one migration
4. **Test migrations against production-sized data** — a migration that works on 100 rows may lock on 10M
5. **Migrations are immutable once deployed** — never edit a migration that has run in production

## Migration Safety Checklist

Before applying any migration:

- [ ] Migration has both UP and DOWN (or is explicitly marked irreversible)
- [ ] No full table locks on large tables (use concurrent operations)
- [ ] New columns have defaults or are nullable (never add NOT NULL without default)
- [ ] Indexes created concurrently (not inline with CREATE TABLE for existing tables)
- [ ] Data backfill is a separate migration from schema change
- [ ] Tested against a copy of production data
- [ ] Rollback plan documented

## PostgreSQL Patterns

### Adding a Column Safely

```sql
-- GOOD: Nullable column, no lock
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- GOOD: Column with default (Postgres 11+ is instant, no rewrite)
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- BAD: NOT NULL without default on existing table (requires full rewrite)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL;
-- This locks the table and rewrites every row
```

### Adding an Index Without Downtime

```sql
-- BAD: Blocks writes on large tables
CREATE INDEX idx_users_email ON users (email);

-- GOOD: Non-blocking, allows concurrent writes
CREATE INDEX CONCURRENTLY idx_users_email ON users (email);

-- Note: CONCURRENTLY cannot run inside a transaction block
-- Most migration tools need special handling for this
```

### Renaming a Column (Zero-Downtime)

Never rename directly in production. Use the expand-contract pattern:

```sql
-- Step 1: Add new column (migration 001)
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Step 2: Backfill data (migration 002, data migration)
UPDATE users SET display_name = username WHERE display_name IS NULL;

-- Step 3: Update application code to read/write both columns
-- Deploy application changes

-- Step 4: Stop writing to old column, drop it (migration 003)
ALTER TABLE users DROP COLUMN username;
```

### Removing a Column Safely

```sql
-- Step 1: Remove all application references to the column
-- Step 2: Deploy application without the column reference
-- Step 3: Drop column in next migration
ALTER TABLE orders DROP COLUMN legacy_status;

-- For Django: use SeparateDatabaseAndState to remove from model
-- without generating DROP COLUMN (then drop in next migration)
```

### Large Data Migrations

```sql
-- BAD: Updates all rows in one transaction (locks table)
UPDATE users SET normalized_email = LOWER(email);

-- GOOD: Batch update with progress
DO $$
DECLARE
  batch_size INT := 10000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE users
    SET normalized_email = LOWER(email)
    WHERE id IN (
      SELECT id FROM users
      WHERE normalized_email IS NULL
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % rows', rows_updated;
    EXIT WHEN rows_updated = 0;
    COMMIT;
  END LOOP;
END $$;
```

## Drizzle ORM (HashHive)

### Workflow

```bash
# 1. Edit schema in shared/src/db/schema.ts
# 2. Generate migration SQL from schema diff
bun --filter backend db:generate

# 3. Review generated SQL in shared/src/db/migrations/
# 4. Apply migrations
bun --filter backend db:migrate

# Dev only: push schema directly (no migration file)
bun --filter backend db:push

# Inspect database
bun --filter backend db:studio
```

### Schema Example (shared/src/db/schema.ts)

```typescript
import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  token: text("token").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  gpuCount: integer("gpu_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

### Custom SQL for Operations Drizzle Can't Express

For concurrent indexes or complex data backfills, create a custom migration:

```bash
# Generate creates a SQL file — edit it manually for CONCURRENTLY
bun --filter backend db:generate
```

```sql
-- In the generated migration file, replace:
CREATE INDEX idx_agents_token ON agents (token);
-- With:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_token ON agents (token);
```

### Drizzle + Zod Schema Flow

```
schema.ts (Drizzle tables)
  → drizzle-zod (generates Zod schemas)
    → z.infer (derives TypeScript types)
      → shared/src/schemas/index.ts (exported for frontend + backend)
```

## Zero-Downtime Migration Strategy

For critical production changes, follow the expand-contract pattern:

```
Phase 1: EXPAND
  - Add new column/table (nullable or with default)
  - Deploy: app writes to BOTH old and new
  - Backfill existing data

Phase 2: MIGRATE
  - Deploy: app reads from NEW, writes to BOTH
  - Verify data consistency

Phase 3: CONTRACT
  - Deploy: app only uses NEW
  - Drop old column/table in separate migration
```

### Timeline Example

```
Day 1: Migration adds new_status column (nullable)
Day 1: Deploy app v2 — writes to both status and new_status
Day 2: Run backfill migration for existing rows
Day 3: Deploy app v3 — reads from new_status only
Day 7: Migration drops old status column
```

## Anti-Patterns

| Anti-Pattern                         | Why It Fails                         | Better Approach                             |
| ------------------------------------ | ------------------------------------ | ------------------------------------------- |
| Manual SQL in production             | No audit trail, unrepeatable         | Always use migration files                  |
| Editing deployed migrations          | Causes drift between environments    | Create new migration instead                |
| NOT NULL without default             | Locks table, rewrites all rows       | Add nullable, backfill, then add constraint |
| Inline index on large table          | Blocks writes during build           | CREATE INDEX CONCURRENTLY                   |
| Schema + data in one migration       | Hard to rollback, long transactions  | Separate migrations                         |
| Dropping column before removing code | Application errors on missing column | Remove code first, drop column next deploy  |
