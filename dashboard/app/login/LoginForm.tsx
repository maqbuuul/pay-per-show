'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { signIn, type SignInState } from './actions';

function SignInButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending} aria-busy={pending || undefined}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

export function LoginForm({ next, demo }: { next: string; demo?: { email: string; password: string } }) {
  const [state, action] = useActionState<SignInState, FormData>(signIn, null);
  const email = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);

  return (
    <form action={action} className="login-form">
      <input type="hidden" name="next" value={next} />
      <label className="field">
        <span>Email</span>
        <input ref={email} type="email" name="email" autoComplete="username" required />
      </label>
      <label className="field">
        <span>Password</span>
        <input ref={password} type="password" name="password" autoComplete="current-password" required />
      </label>
      {state?.error && <p role="alert" className="result is-error">{state.error}</p>}
      <SignInButton />
      {demo && (
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => {
            if (email.current) email.current.value = demo.email;
            if (password.current) password.current.value = demo.password;
          }}
        >
          Fill in the demo account
        </button>
      )}
    </form>
  );
}
