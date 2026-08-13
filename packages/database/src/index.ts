import { drizzle } from 'drizzle-orm/bun-sql';

import * as schema from './schema';

export function createDatabase(databaseUrl: string) {
  if (!databaseUrl) {
    throw new Error('databaseUrl is required');
  }

  return drizzle(databaseUrl, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
export * from './schema';
export * from './catalog-normalization';
export * from './calculation-snapshot';
