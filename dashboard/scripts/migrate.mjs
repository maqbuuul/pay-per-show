#!/usr/bin/env node
// Applies db/schema.sql and db/demo.sql. Both are safe to re-run.
//
//   npm run migrate            apply schema and functions
//   npm run migrate -- --seed  also rebuild the demo data

import { Client, neonConfig } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../db');
const client = new Client(url);
await client.connect();

try {
  for (const file of ['schema.sql', 'demo.sql']) {
    // Sent as one simple query, so function bodies containing semicolons are fine.
    await client.query(readFileSync(resolve(root, file), 'utf8'));
    console.log(`applied ${file}`);
  }
  if (process.argv.includes('--seed')) {
    const { rows } = await client.query(`SELECT pps.reset_demo('migrate') AS r`);
    console.log('demo data:', rows[0].r);
  }
} finally {
  await client.end();
}
