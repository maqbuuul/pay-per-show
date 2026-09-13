'use server';

import { redirect } from 'next/navigation';
import {
  clientIp, createSession, endSession, recordAttempt, throttle, verifyPassword,
} from '@/lib/auth';
import { sql } from '@/lib/db';

export type SignInState = { error: string } | null;

// Checked when the email is unknown, so the response time does not reveal
// which emails have accounts.
const DECOY = 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function safeNext(value: string) {
  try {
    const url = new URL(value, 'http://local');
    return url.origin === 'http://local' ? url.pathname + url.search : '/';
  } catch {
    return '/';
  }
}

export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.' };

  const ip = await clientIp();
  const blocked = await throttle(email, ip);
  if (blocked) return { error: blocked };

  const [user] = await sql<{ user_id: string; password_hash: string }>`
    SELECT user_id::text AS user_id, password_hash FROM pps.users WHERE email = ${email}`;
  const ok = await verifyPassword(password, user?.password_hash ?? DECOY) && Boolean(user);
  await recordAttempt(email, ip, ok);
  if (!ok) return { error: 'That email and password do not match.' };

  await createSession(user.user_id);
  redirect(safeNext(String(form.get('next') ?? '/')));
}

export async function signOut() {
  await endSession();
  redirect('/login');
}
