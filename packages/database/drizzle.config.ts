import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: '.env.local' });

const databaseUrl = process.env.DATABASE_URL;
const schemaOnly = process.env.NUEAT_DATABASE_SCHEMA_ONLY === '1';

if (
  !schemaOnly && (
    process.env.NUEAT_VERIFIED_DATABASE_TARGET !== 'neon-control-plane-v2-guard-v1' ||
    !databaseUrl
  )
) {
  throw new Error('Database commands must be launched through the verified migration wrapper');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: process.env.NUEAT_DRIZZLE_OUT ?? './drizzle',
  ...(schemaOnly ? {} : { dbCredentials: { url: databaseUrl! } }),
  strict: true,
  verbose: true,
});
