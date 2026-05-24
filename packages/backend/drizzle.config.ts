import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../shared/src/db/schema.ts',
  out: '../shared/src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] || 'postgres://hashhive:hashhive@localhost:5432/hashhive',
  },
})
