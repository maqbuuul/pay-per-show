import Link from 'next/link';
import type { ReactNode } from 'react';
import { BILLING, OUTCOME, RESOLUTION, label } from '@/lib/format';

export function PageHeader({
  title, meta, actions, back,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="page-header">
      <div className="page-title">
        {back && <Link href={back.href} className="back-link">{'←'} {back.label}</Link>}
        <h1>{title}</h1>
        {meta && <p className="page-meta">{meta}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const OUTCOME_TONE: Record<string, Tone> = { attended: 'green', no_show: 'red', unmarked: 'amber', cancelled: 'neutral' };
const BILLING_TONE: Record<string, Tone> = { billable: 'blue', invoiced: 'neutral', written_off: 'amber', not_billable: 'neutral' };

export const OutcomeBadge = ({ outcome }: { outcome: string }) =>
  <Badge tone={OUTCOME_TONE[outcome]}>{label(OUTCOME, outcome)}</Badge>;

export const BillingBadge = ({ billing }: { billing: string }) =>
  <Badge tone={BILLING_TONE[billing]}>{label(BILLING, billing)}</Badge>;

export function InvoiceStatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) return <Badge tone="red">Overdue</Badge>;
  const tone: Tone = status === 'paid' ? 'green' : status === 'sent' ? 'blue' : 'neutral';
  return <Badge tone={tone}>{status[0].toUpperCase() + status.slice(1)}</Badge>;
}

export function DisputeBadge({ resolution }: { resolution: string | null }) {
  if (!resolution) return <Badge tone="amber">Open</Badge>;
  return <Badge tone={resolution === 'rejected' ? 'neutral' : 'green'}>{label(RESOLUTION, resolution)}</Badge>;
}

export function Tabs({ items }: { items: { href: string; label: string; count?: number; active: boolean }[] }) {
  return (
    <nav className="tabs" aria-label="Filter">
      {items.map((t) => (
        <Link key={t.href} href={t.href} className={t.active ? 'tab is-active' : 'tab'} aria-current={t.active ? 'page' : undefined}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Pager({ page, total, size, href }: {
  page: number; total: number; size: number; href: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pages">
      {page > 0
        ? <Link href={href(page - 1)} className="btn btn-secondary btn-sm">Previous</Link>
        : <span className="btn btn-secondary btn-sm is-disabled" aria-disabled="true">Previous</span>}
      <span className="muted">Page {page + 1} of {pages}</span>
      {page + 1 < pages
        ? <Link href={href(page + 1)} className="btn btn-secondary btn-sm">Next</Link>
        : <span className="btn btn-secondary btn-sm is-disabled" aria-disabled="true">Next</span>}
    </nav>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
