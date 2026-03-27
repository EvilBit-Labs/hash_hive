# HashHive justfile - Common development commands

set shell := ["bash", "-cu"]
set dotenv-load := true

# Use mise to manage all dev tools (bun, biome, etc.)
# See mise.toml for tool versions
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
    {{ mise_exec }} bun update
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
    @docker compose ps 2>/dev/null || echo "Docker services not running"

# -----------------------------
# Linting, Typing, Formatting
# -----------------------------

# Lint all code
lint:
    {{ mise_exec }} bun run lint

# Format all code
format:
    {{ mise_exec }} bun run format

# Check code formatting
format-check:
    {{ mise_exec }} bun run format:check

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

# Run E2E tests
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
    docker compose up -d

# Stop Docker services
docker-down:
    docker compose down

# View Docker logs
docker-logs:
    docker compose logs -f

# View logs for specific service
docker-logs-service service:
    docker compose logs -f {{ service }}

# Reset Docker volumes and restart
docker-reset:
    docker compose down -v
    docker compose up -d

# Check Docker service status
docker-status:
    docker compose ps

# Clean Docker volumes
clean-docker:
    docker compose down -v

# Full clean (code + docker)
clean-all: clean clean-docker

# -----------------------------
# Database
# -----------------------------

# Connect to PostgreSQL shell
psql-shell:
    psql -U hashhive hashhive

# Connect to Redis CLI
redis-cli:
    docker compose exec redis redis-cli

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

# Run the full CI check locally.
# Backend tests use bun:test with mocked services — no docker-compose required.
# Order matters: lint → format → types → build (catches Tailwind CSS generation) → test
ci-check: check test

# Quick quality gate — run after every task (no tests, faster than ci-check)
check: pre-commit lint format-check type-check build
