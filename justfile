# HashHive justfile - Common development commands

set shell := ["bash", "-cu"]
set dotenv-load := true

# Use mise to manage all dev tools (bun, oxlint, oxfmt, taplo, etc.).
# See mise.toml for tool versions.
mise_exec := "mise exec --"

# Show available recipes
default:
    @just --choose

# -----------------------------
# Setup & Installation
# -----------------------------

# Install all dependencies
install:
    {{ mise_exec }} bun install

# Copy environment files from examples
env-setup:
    cp packages/backend/.env.example packages/backend/.env

# Install pre-commit hooks
install-hooks:
    {{ mise_exec }} pre-commit install

# Update dependencies
update-deps:
    mise upgrade --bump --local
    {{ mise_exec }} bun update  --minimum-release-age=172800
    {{ mise_exec }} bun update --recursive --minimum-release-age=172800 --filter @hashhive/backend --filter @hashhive/frontend --filter @hashhive/shared
    {{ mise_exec }} pre-commit autoupdate

# -----------------------------
# Development Environment
# -----------------------------

# Start development servers (backend + frontend)
dev:
    {{ mise_exec }} bun run dev

# Start backend only
dev-backend:
    {{ mise_exec }} bun --filter @hashhive/backend dev

# Start frontend only
dev-frontend:
    {{ mise_exec }} bun --filter @hashhive/frontend dev

# Show environment info
info:
    @echo "Bun version: $({{ mise_exec }} bun --version)"
    @echo "Docker version: $(docker --version 2>/dev/null || echo 'not installed')"
    @echo ""
    @{{ mise_exec }} docker compose ps 2>/dev/null || echo "Docker services not running"

# -----------------------------
# Linting, Typing, Formatting
# -----------------------------

# Lint all code with oxlint (type-aware mode reads tsconfig context).
lint:
    {{ mise_exec }} oxlint --type-aware

# Run oxlint with auto-fixes across the whole tree.
lint-fix:
    {{ mise_exec }} oxlint --type-aware --fix

# Format all code: oxfmt for JS/TS/CSS/JSON; taplo for TOML.
# oxfmt has no TOML alignment knobs, so taplo handles `mise.toml` and
# friends with `align_entries = true` configured in `.taplo.toml`.
# `oxfmt` ignores TOMLs via `.oxfmtrc.json` so the two don't fight.
format: format-toml
    {{ mise_exec }} oxfmt

# Check formatting without writing changes (oxfmt + taplo).
format-check: format-toml-check
    {{ mise_exec }} oxfmt --check

# Format all TOML files with taplo. Configured in `.taplo.toml`.
format-toml:
    {{ mise_exec }} taplo fmt

# Check TOML formatting without writing changes.
format-toml-check:
    {{ mise_exec }} taplo fmt --check

# Run TypeScript type checking
type-check:
    {{ mise_exec }} bun run type-check

pre-commit:
    {{ mise_exec }} pre-commit run --all-files

# -----------------------------
# Testing
# -----------------------------

# Run all tests
test:
    {{ mise_exec }} bun run test

# Run backend tests
test-backend:
    {{ mise_exec }} bun --filter @hashhive/backend test

# Run frontend tests
test-frontend:
    {{ mise_exec }} bun --filter @hashhive/frontend test

# Install Playwright browsers (run once; idempotent if already cached).
# Uses the workspace's pinned `@playwright/test` to avoid version skew —
# never use `bunx playwright install`.
test-e2e-install:
    {{ mise_exec }} bun --filter @hashhive/frontend test:e2e:install

# Run E2E tests (assumes browsers already installed via `test-e2e-install`)
test-e2e:
    {{ mise_exec }} bun run test:e2e

# -----------------------------
# Build & Clean
# -----------------------------

# Build all packages (Turborepo cached, dependency-ordered)
build:
    {{ mise_exec }} bun run build

# Build specific package
build-backend:
    {{ mise_exec }} bun --filter @hashhive/backend build

build-frontend:
    {{ mise_exec }} bun --filter @hashhive/frontend build

build-shared:
    {{ mise_exec }} bun --filter @hashhive/shared build

# Clean build artifacts and dependencies
[unix]
clean:
    rm -rf node_modules
    rm -rf packages/backend/node_modules packages/backend/dist
    rm -rf packages/frontend/node_modules packages/frontend/dist
    rm -rf packages/shared/node_modules packages/shared/dist
    rm -rf .turbo packages/*/.turbo

# -----------------------------
# Docker & Infrastructure
# -----------------------------

# Start Docker services
docker-up:
    {{ mise_exec }} docker compose up -d

# Stop Docker services
docker-down:
    {{ mise_exec }} docker compose down

# View Docker logs
docker-logs:
    {{ mise_exec }} docker compose logs -f

# View logs for specific service
docker-logs-service service:
    {{ mise_exec }} docker compose logs -f {{ service }}

# Reset Docker volumes and restart
docker-reset:
    {{ mise_exec }} docker compose down -v
    {{ mise_exec }} docker compose up -d --remove-orphans

# Check Docker service status
docker-status:
    {{ mise_exec }} docker compose ps

# Clean Docker volumes
clean-docker:
    {{ mise_exec }} docker compose down -v

# Full clean (code + docker)
clean-all: clean clean-docker

# -----------------------------
# Database
# -----------------------------

# Connect to PostgreSQL shell
psql-shell:
    {{ mise_exec }} docker compose exec postgres psql -U hashhive hashhive

# Connect to Redis CLI
redis-cli:
    {{ mise_exec }} docker compose exec redis redis-cli

# Generate Drizzle migrations
db-generate:
    {{ mise_exec }} bun --filter @hashhive/backend db:generate

# Run Drizzle migrations
db-migrate:
    {{ mise_exec }} bun --filter @hashhive/backend db:migrate

# Seed admin user and default project
db-seed:
    {{ mise_exec }} bun --filter @hashhive/backend db:seed

# Open Drizzle Studio
db-studio:
    {{ mise_exec }} bun --filter @hashhive/backend db:studio

# -----------------------------
# CI Workflow
# -----------------------------

# Run the full pre-push gate locally. Stricter than the GitHub `ci-check`
# job — this is what you run before pushing to catch everything CI catches
# plus the e2e job. Backend tests use bun:test with mocked services
# (no docker-compose required); e2e needs Playwright browsers
# (`just test-e2e-install` once after `just install`).
# Order: lint → format → types → build (catches Tailwind generation) → unit → e2e
ci-check: check test test-e2e

# Quick quality gate — run after every task (no tests, faster than ci-check).
# `pre-commit` already runs format-check + oxlint + type-check via its hooks,
# so we only add `build` (which catches Tailwind generation failures).
check: pre-commit build
