'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({
  href, children, count, exact = false,
}: {
  href: string;
  children: ReactNode;
  count?: number;
  exact?: boolean;
}) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link href={href} className={active ? 'nav-link is-active' : 'nav-link'} aria-current={active ? 'page' : undefined}>
      <span>{children}</span>
      {count ? <span className="nav-count">{count}</span> : null}
    </Link>
  );
}

/** Ticks every enabled appointment checkbox in the surrounding form. */
export function SelectAll() {
  return (
    <input
      type="checkbox"
      aria-label="Select all appointments on this page"
      onChange={(e) => {
        const checked = e.currentTarget.checked;
        e.currentTarget
          .closest('form')
          ?.querySelectorAll<HTMLInputElement>('input[name="ids"]:not(:disabled)')
          .forEach((box) => { box.checked = checked; });
      }}
    />
  );
}

export function PrintButton() {
  return (
    <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
      Print
    </button>
  );
}
