#!/usr/bin/env node
// Creates a user, or resets the name and password of an existing one.
//
//   npm run create-user -- <email> "<name>" <password> [--demo]

import { neon } from '@neondatabase/serverless';
import { randomBytes, scrypt } from 'node:crypto';

const [email, name, password] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const isDemo = process.argv.includes('--demo');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!email || !name || !password) {
  console.error('Usage: npm run create-user -- <email> "<name>" <password> [--demo]');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Use a password of at least 10 characters.');
  process.exit(1);
}

// Same format as lib/auth.ts: scrypt$N$r$p$salt$hash
const salt = randomBytes(16);
const key = await new Promise((ok, fail) =>
  scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, k) => (err ? fail(err) : ok(k))));
const hash = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;

const sql = neon(process.env.DATABASE_URL);
const [row] = await sql`
  INSERT INTO pps.users (email, name, password_hash, is_demo)
  VALUES (${email.toLowerCase()}, ${name}, ${hash}, ${isDemo})
  ON CONFLICT (email) DO UPDATE
     SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, is_demo = EXCLUDED.is_demo
  RETURNING user_id, email, is_demo`;

console.log(`saved user ${row.email}${row.is_demo ? ' (demo)' : ''}`);
