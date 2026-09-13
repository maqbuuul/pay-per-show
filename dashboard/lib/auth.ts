import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { sql } from './db';

export const SESSION_COOKIE = 'pps_session';
const SESSION_DAYS = 7;

export type User = { user_id: string; email: string; name: string; is_demo: boolean };

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

/** Format: scrypt$N$r$p$salt$hash, with base64 salt and hash. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 16384, 8, 1);
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await sql`DELETE FROM pps.sessions WHERE expires_at < now()`;
  await sql`
    INSERT INTO pps.sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash(token)}, ${userId}::bigint, now() + make_interval(days => ${SESSION_DAYS}))`;
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await sql`DELETE FROM pps.sessions WHERE token_hash = ${tokenHash(token)}`;
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user, checked against the database once per request. */
export const currentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const hash = tokenHash(token);
  const [row] = await sql<User & { stale: boolean }>`
    SELECT u.user_id::text AS user_id, u.email, u.name, u.is_demo,
           s.last_seen_at < now() - interval '1 hour' AS stale
      FROM pps.sessions s
      JOIN pps.users u ON u.user_id = s.user_id
     WHERE s.token_hash = ${hash} AND s.expires_at > now()`;
  if (!row) return null;
  if (row.stale) {
    await sql`
      UPDATE pps.sessions
         SET last_seen_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS})
       WHERE token_hash = ${hash}`;
  }
  return { user_id: row.user_id, email: row.email, name: row.name, is_demo: row.is_demo };
});

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

export async function clientIp() {
  const h = await headers();
  return (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
}

/**
 * Refuses an attempt after repeated failures. Limits are per network and per
 * email on that network, never per email alone, so nobody can lock another
 * person out of their account.
 */
export async function throttle(email: string, ip: string): Promise<string | null> {
  const [r] = await sql<{ by_ip: number; by_pair: number; last_fail: Date | null }>`
    SELECT count(*)::int                                        AS by_ip,
           count(*) FILTER (WHERE email = ${email})::int         AS by_pair,
           max(at) FILTER (WHERE email = ${email})               AS last_fail
      FROM pps.login_attempts
     WHERE ip = ${ip} AND NOT ok AND at > now() - interval '15 minutes'`;
  if (r.by_ip >= 30) {
    return 'Too many failed sign-ins from this network. Try again in 15 minutes.';
  }
  if (r.by_pair >= 5 && r.last_fail) {
    const wait = Math.min(300, 5 * 2 ** (r.by_pair - 5));
    const left = Math.ceil(wait - (Date.now() - new Date(r.last_fail).getTime()) / 1000);
    if (left > 0) return `Too many failed attempts. Try again in ${left} seconds.`;
  }
  return null;
}

export async function recordAttempt(email: string, ip: string, ok: boolean) {
  await sql`INSERT INTO pps.login_attempts (email, ip, ok) VALUES (${email}, ${ip}, ${ok})`;
}
