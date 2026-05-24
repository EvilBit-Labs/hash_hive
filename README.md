# HashHive

HashHive is a distributed password cracking platform that orchestrates hashcat across multiple agents in a LAN environment. Built with the MERN stack (MongoDB, Express, React, Node.js) and TypeScript throughout.

## Project Structure

```text
hashhive/
├── backend/          # Node.js + Express API server
├── frontend/         # Next.js + React web UI
├── shared/           # Shared TypeScript types
├── openapi/          # API specifications
└── docs/             # Documentation
```

## Prerequisites

- Node.js 20+ and npm 10+
- Docker and Docker Compose
- Git
- [just](https://github.com/casey/just) (optional, for convenient command running)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Infrastructure Services

```bash
docker compose up -d
```

This starts:

- MongoDB on port 27017
- Redis on port 6379
- SeaweedFS on ports 9000 (S3 API) and 9333 (master UI)

### 3. Configure Environment

```bash
# Backend
cp backend/.env.example backend/.env

# Frontend
cp frontend/.env.example frontend/.env
```

### 4. Start Development Servers

```bash
# Start both backend and frontend
npm run dev

# Or start individually
npm run dev -w backend
npm run dev -w frontend
```

- Backend API: <http://localhost:3001>
- Frontend UI: <http://localhost:3000>
- SeaweedFS Master UI: <http://localhost:9333> (S3 API on 9000, credentials minioadmin/minioadmin)

## Development

### Available Scripts

Use `just` for common commands (or run npm scripts directly):

```bash
# Development
just dev                 # Start all services
just dev-backend         # Start backend only
just dev-frontend        # Start frontend only

# Building
just build               # Build all packages
just build-backend       # Build backend only
just build-frontend      # Build frontend only

# Testing
just test                # Run all tests
just test-backend        # Backend tests
just test-frontend       # Frontend tests
just test-integration    # Integration tests
just test-e2e            # E2E tests

# Code Quality
just lint                # Lint all packages
just format              # Format code with Prettier
just type-check          # TypeScript type checking

# Docker
just docker-up           # Start services
just docker-down         # Stop services
just docker-logs         # View logs

# Or use npm scripts directly
npm run dev              # Start all services
npm run build            # Build all packages
npm run test             # Run all tests
```

### Project Configuration

- **TypeScript**: Strict mode enabled with shared base config
- **ESLint**: Consistent rules across all packages
- **Prettier**: Automated code formatting (TypeScript, JavaScript, JSON, Markdown, YAML)
- **Jest**: Unit and integration testing
- **Playwright**: E2E testing for frontend

## Architecture

HashHive follows a monorepo structure with:

- **Backend**: Express API with Mongoose ODM, BullMQ for queues, Pino for logging
- **Frontend**: Next.js with App Router, shadcn/ui components, React Query for data fetching
- **Shared**: Common TypeScript types and Zod schemas

## Infrastructure Services

### MongoDB

- Primary database for all application data
- Mongoose ODM with TypeScript support
- Health checks and automatic reconnection

### Redis

- BullMQ job queues for task distribution
- Session storage
- Caching layer

### SeaweedFS

- S3-compatible object storage (Apache-2.0)
- Stores hash lists, wordlists, and other binary artifacts
- Replaces MinIO (MinIO upstream archived April 2026); the application talks the S3 API only, so AWS S3 is a drop-in substitute in hosted deployments

## Testing

```bash
# Run all tests
npm test

# Backend unit tests
npm run test -w backend

# Backend integration tests (requires Docker)
npm run test:integration -w backend

# Frontend component tests
npm run test -w frontend

# E2E tests
npm run test:e2e -w frontend
```

## Documentation

See the `docs/` directory for:

- MERN migration proposal
- Implementation plans
- Architecture decisions
- API specifications

## License

This is a test/development project based on the CipherSwarm architecture, and is relicensed under the Apache-2.0 license.
