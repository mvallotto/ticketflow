import 'dotenv/config';

// Tests must never connect to the development database or a remote server.
if (process.env.VITEST) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for tests');
  }

  const url = new URL(databaseUrl);

  if (
    url.hostname !== 'localhost' &&
    url.hostname !== '127.0.0.1'
  ) {
    throw new Error('Tests must use a local PostgreSQL instance');
  }

  if (
    url.port !== '5433' ||
    url.pathname !== '/ticketflow_test'
  ) {
    throw new Error(
      'Tests must use ticketflow_test on port 5433',
    );
  }
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
