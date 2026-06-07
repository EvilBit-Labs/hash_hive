// Set test environment variables before any imports
process.env['NODE_ENV'] = 'test'
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
// Mirrors the Playwright E2E suite's own env-var population: the
// shared trusted-origins helper accepts comma-separated extras on
// top of the localhost:3000 dev default, and tests exercise both the
// base and the extra entry.
process.env['BETTER_AUTH_TRUSTED_ORIGINS'] = 'http://localhost:3400'
