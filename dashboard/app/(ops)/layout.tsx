import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ActionForm, Submit } from '@/components/ActionForm';
import { NavLink } from '@/components/client';
import { Flash } from '@/components/Flash';
import { signOut } from '@/app/login/actions';
import { resetDemo } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import { navCounts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const counts = await navCounts();

  const raw = (await cookies()).get('pps_flash')?.value;
  const split = raw ? raw.indexOf('|') : -1;
  const flash = split > 0 ? { id: raw!.slice(0, split), message: raw!.slice(split + 1) } : undefined;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="wordmark">Pay Per Show</Link>
        <nav className="nav" aria-label="Main">
          <NavLink href="/" exact>Today</NavLink>
          <NavLink href="/appointments" count={counts.unmarked}>Appointments</NavLink>
          <NavLink href="/invoices" count={counts.drafts}>Invoices</NavLink>
          <NavLink href="/disputes" count={counts.disputes}>Disputes</NavLink>
          <NavLink href="/clinics">Clinics</NavLink>
          <NavLink href="/activity">Activity</NavLink>
        </nav>

        <div className="sidebar-foot">
          {user.is_demo && (
            <details className="demo-box">
              <summary>Demo data</summary>
              <p>Synthetic clinics, shared by everyone using the demo. Resets nightly at 03:00 UTC.</p>
              <ActionForm action={resetDemo}>
                <Submit variant="secondary" size="sm">Reset now</Submit>
              </ActionForm>
            </details>
          )}
          <div className="who">
            <span className="who-name">{user.name}</span>
            <span className="who-email">{user.email}</span>
          </div>
          <form action={signOut}>
            <button type="submit" className="btn btn-ghost btn-sm">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="main">
        <Flash id={flash?.id} message={flash?.message} />
        {children}
      </main>
    </div>
  );
}
