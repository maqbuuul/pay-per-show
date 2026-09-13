'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/actions';

type Action = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

/**
 * A form bound to a server action. Errors appear next to the form, since
 * nothing changed and the form is still there. Success is announced by the
 * page-level notice, because the form is often gone once the page updates.
 */
export function ActionForm({
  action, children, className, resultFirst = false,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  /** Show the error above the form, for forms taller than the screen. */
  resultFirst?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const result = state && !state.ok && (
    <p role="alert" className="result is-error">{state.error}</p>
  );
  return (
    <form action={formAction} className={className}>
      {resultFirst && result}
      {children}
      {!resultFirst && result}
    </form>
  );
}

export function Submit({
  children, variant = 'primary', size, name, value, disabled,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm';
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={`btn btn-${variant}${size ? ` btn-${size}` : ''}`}
    >
      {children}
    </button>
  );
}
