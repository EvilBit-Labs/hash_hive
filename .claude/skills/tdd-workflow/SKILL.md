---
name: tdd-workflow
description: TDD workflow for HashHive using bun:test. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.
origin: ECC (optimized for HashHive)
---

# Test-Driven Development Workflow

> **HashHive context:** All tests use `bun:test` (not Jest, not Vitest). Use `mock()` instead of `mock()`, `mock.module()` instead of `jest.mock()`. Commands: `bun test` (all), `bun --filter backend test`, `bun --filter frontend test`, `bun test:e2e` (Playwright).

This skill ensures all code development follows TDD principles with comprehensive test coverage.

## When to Activate

- Writing new features or functionality
- Fixing bugs or issues
- Refactoring existing code
- Adding API endpoints
- Creating new components

## Core Principles

### 1. Tests BEFORE Code

ALWAYS write tests first, then implement code to make tests pass.

### 2. Coverage Requirements

- Minimum 80% coverage (unit + integration + E2E)
- All edge cases covered
- Error scenarios tested
- Boundary conditions verified

### 3. Test Types

#### Unit Tests

- Individual functions and utilities
- Component logic
- Pure functions
- Helpers and utilities

#### Integration Tests

- API endpoints
- Database operations
- Service interactions
- External API calls

#### E2E Tests (Playwright)

- Critical user flows
- Complete workflows
- Browser automation
- UI interactions

## TDD Workflow Steps

### Step 1: Write User Journeys

```
As a [role], I want to [action], so that [benefit]

Example:
As a user, I want to search for markets semantically,
so that I can find relevant markets even without exact keywords.
```

### Step 2: Generate Test Cases

For each user journey, create comprehensive test cases:

```typescript
describe("Semantic Search", () => {
  it("returns relevant markets for query", async () => {
    // Test implementation
  });

  it("handles empty query gracefully", async () => {
    // Test edge case
  });

  it("falls back to substring search when Redis unavailable", async () => {
    // Test fallback behavior
  });

  it("sorts results by similarity score", async () => {
    // Test sorting logic
  });
});
```

### Step 3: Run Tests (They Should Fail)

```bash
bun test
# Tests should fail - we haven't implemented yet
```

### Step 4: Implement Code

Write minimal code to make tests pass:

```typescript
// Implementation guided by tests
export async function searchMarkets(query: string) {
  // Implementation here
}
```

### Step 5: Run Tests Again

```bash
bun test
# Tests should now pass
```

### Step 6: Refactor

Improve code quality while keeping tests green:

- Remove duplication
- Improve naming
- Optimize performance
- Enhance readability

### Step 7: Verify Coverage

```bash
bun test --coverage
# Verify 80%+ coverage achieved
```

## Testing Patterns

### Unit Test Pattern (bun:test)

```typescript
import { render, screen, fireEvent } from '@testing-library/react'
import { Button } from './Button'

describe('Button Component', () => {
  it('renders with correct text', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByText('Click me')).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const handleClick = mock()
    render(<Button onClick={handleClick}>Click</Button>)

    fireEvent.click(screen.getByRole('button'))

    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Click</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
  })
})
```

### API Integration Test Pattern (Hono)

```typescript
import { describe, it, expect } from "bun:test";
import app from "../src/index";

describe("GET /api/v1/dashboard/campaigns", () => {
  it("returns campaigns successfully", async () => {
    const response = await app.request("/api/v1/dashboard/campaigns", {
      headers: { Cookie: `session=${testSessionToken}` },
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("validates query parameters", async () => {
    const response = await app.request(
      "/api/v1/dashboard/campaigns?limit=invalid",
      {
        headers: { Cookie: `session=${testSessionToken}` },
      },
    );

    expect(response.status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const response = await app.request("/api/v1/dashboard/campaigns");

    expect(response.status).toBe(401);
  });
});
```

### E2E Test Pattern (Playwright)

```typescript
import { test, expect } from "@playwright/test";

test("user can search and filter markets", async ({ page }) => {
  // Navigate to markets page
  await page.goto("/");
  await page.click('a[href="/markets"]');

  // Verify page loaded
  await expect(page.locator("h1")).toContainText("Markets");

  // Search for markets
  await page.fill('input[placeholder="Search markets"]', "election");

  // Wait for debounce and results
  await page.waitForTimeout(600);

  // Verify search results displayed
  const results = page.locator('[data-testid="market-card"]');
  await expect(results).toHaveCount(5, { timeout: 5000 });

  // Verify results contain search term
  const firstResult = results.first();
  await expect(firstResult).toContainText("election", { ignoreCase: true });

  // Filter by status
  await page.click('button:has-text("Active")');

  // Verify filtered results
  await expect(results).toHaveCount(3);
});

test("user can create a new market", async ({ page }) => {
  // Login first
  await page.goto("/creator-dashboard");

  // Fill market creation form
  await page.fill('input[name="name"]', "Test Market");
  await page.fill('textarea[name="description"]', "Test description");
  await page.fill('input[name="endDate"]', "2025-12-31");

  // Submit form
  await page.click('button[type="submit"]');

  // Verify success message
  await expect(page.locator("text=Market created successfully")).toBeVisible();

  // Verify redirect to market page
  await expect(page).toHaveURL(/\/markets\/test-market/);
});
```

## Test File Organization

```
packages/
├── backend/
│   ├── src/routes/                   # Route handlers
│   └── tests/
│       ├── unit/                     # Service and utility tests
│       └── integration/              # API endpoint tests
├── frontend/
│   ├── src/components/               # React components
│   │   ├── Button.tsx
│   │   └── Button.test.tsx           # Co-located unit tests
│   └── tests/
│       └── e2e/                      # Playwright E2E tests
└── shared/
    └── src/schemas/
        └── __tests__/                # Schema validation tests
```

## Mocking External Services

### Drizzle DB Mock (bun:test)

```typescript
import { mock } from "bun:test";

mock.module("@/db", () => ({
  db: {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([{ id: 1, name: "Test Campaign" }])),
      })),
    })),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([{ id: 1 }])),
      })),
    })),
  },
}));
```

### Redis/BullMQ Mock (bun:test)

```typescript
import { mock } from "bun:test";

mock.module("@/lib/redis", () => ({
  redis: {
    get: mock(() => Promise.resolve(null)),
    set: mock(() => Promise.resolve("OK")),
  },
}));
```

### MinIO/S3 Mock (bun:test)

```typescript
import { mock } from "bun:test";

mock.module("@/lib/storage", () => ({
  uploadToS3: mock(() => Promise.resolve({ key: "test/file.txt" })),
  getPresignedUrl: mock(() => Promise.resolve("https://minio:9000/test")),
}));
```

## Test Coverage Verification

### Run Coverage Report

```bash
bun test --coverage
```

### Coverage Thresholds (package.json)

```json
{
  "coverageThreshold": {
    "line": 80,
    "function": 80
  }
}
```

## Common Testing Mistakes to Avoid

### ❌ WRONG: Testing Implementation Details

```typescript
// Don't test internal state
expect(component.state.count).toBe(5);
```

### ✅ CORRECT: Test User-Visible Behavior

```typescript
// Test what users see
expect(screen.getByText("Count: 5")).toBeInTheDocument();
```

### ❌ WRONG: Brittle Selectors

```typescript
// Breaks easily
await page.click(".css-class-xyz");
```

### ✅ CORRECT: Semantic Selectors

```typescript
// Resilient to changes
await page.click('button:has-text("Submit")');
await page.click('[data-testid="submit-button"]');
```

### ❌ WRONG: No Test Isolation

```typescript
// Tests depend on each other
test("creates user", () => {
  /* ... */
});
test("updates same user", () => {
  /* depends on previous test */
});
```

### ✅ CORRECT: Independent Tests

```typescript
// Each test sets up its own data
test("creates user", () => {
  const user = createTestUser();
  // Test logic
});

test("updates user", () => {
  const user = createTestUser();
  // Update logic
});
```

## Continuous Testing

### Watch Mode During Development

```bash
bun test --watch
# Tests run automatically on file changes
```

### Pre-Commit Hook

```bash
# Runs before every commit
bun test && bun lint
```

### CI/CD Integration

```yaml
# GitHub Actions
- name: Run Tests
  run: bun test --coverage
- name: Upload Coverage
  uses: codecov/codecov-action@v3
```

## Best Practices

1. **Write Tests First** - Always TDD
2. **One Assert Per Test** - Focus on single behavior
3. **Descriptive Test Names** - Explain what's tested
4. **Arrange-Act-Assert** - Clear test structure
5. **Mock External Dependencies** - Isolate unit tests
6. **Test Edge Cases** - Null, undefined, empty, large
7. **Test Error Paths** - Not just happy paths
8. **Keep Tests Fast** - Unit tests < 50ms each
9. **Clean Up After Tests** - No side effects
10. **Review Coverage Reports** - Identify gaps

## Success Metrics

- 80%+ code coverage achieved
- All tests passing (green)
- No skipped or disabled tests
- Fast test execution (< 30s for unit tests)
- E2E tests cover critical user flows
- Tests catch bugs before production

---

**Remember**: Tests are not optional. They are the safety net that enables confident refactoring, rapid development, and production reliability.
