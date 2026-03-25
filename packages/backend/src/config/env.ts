import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // PostgreSQL
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // MinIO (S3-compatible storage)
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default('hashhive'),
  S3_REGION: z.string().default('us-east-1'),

  // JWT
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRY: z.string().default('24h'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    const missing = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(', ')}`)
      .join('\n');

    throw new Error(`Invalid environment variables:\n${missing}`);
  }

  return result.data;
}

export const env = loadEnv();
