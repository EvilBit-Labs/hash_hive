// Preload for tests that need to observe production-mode behavior in
// modules whose env snapshot is captured at first import (e.g.
// `src/config/env.ts` exports a `const env = loadEnv()` at module
// load — mutating `process.env` *after* the import has no effect).
//
// Mirrors `preload.ts` except `NODE_ENV='production'`. Used by isolated
// test files invoked via `OPENAPI_SPEC_CACHE_PROD_TEST_ISOLATED=1
// bun test --preload ./tests/preload-prod.ts ...` so the preload runs
// before any project import.
process.env['NODE_ENV'] = 'production'
process.env['PORT'] = '4001'
process.env['LOG_LEVEL'] = 'silent'
process.env['LOG_PRETTY'] = 'false'
process.env['DATABASE_URL'] = 'postgres://hashhive:hashhive@localhost:5432/hashhive_test'
process.env['REDIS_URL'] = 'redis://localhost:6379'
process.env['S3_ENDPOINT'] = 'http://localhost:9000'
process.env['S3_ACCESS_KEY'] = 'minioadmin'
process.env['S3_SECRET_KEY'] = 'minioadmin'
process.env['S3_BUCKET'] = 'hashhive-test'
process.env['S3_REGION'] = 'us-east-1'
process.env['BETTER_AUTH_SECRET'] = 'test-betterauth-secret-must-be-at-least-32-characters'
