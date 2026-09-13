import Link from 'next/link';
import type { ReactNode } from 'react';
import { ActionForm, Submit } from '@/components/ActionForm';
import { Badge, Empty, PageHeader, Section } from '@/components/ui';
import { draftInvoices } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import {
  AGENCY_TZ, NET_DAYS, age, isoDay, money, moneyByCurrency, period, plural, qs,
} from '@/lib/format';
import {
  clinicHealth, openDisputeSummary, openInvoiceTotals, undraftedPeriods, unmarkedByClinic,
} from '@/lib/queries';

export const metadata = { title: 'Today' };

// A front desk that has stopped recording shows up as a share of that clinic's
// own appointments, not as a raw count; a count only ranks clinics by size.
const STOPPED_PCT = 8;
const STOPPED_DAYS = 7;

function Task({ tone, title, detail, amount, action }: {
  tone: 'red' | 'amber' | 'blue';
  title: ReactNode;
  detail?: ReactNode;
  amount?: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className={`task task-${tone}`}>
      <div className="task-body">
        <p className="task-title">{title}</p>
        {detail && <p className="task-detail">{detail}</p>}
      </div>
      <p className="task-amount">{amount}</p>
      <div className="task-action">{action}</div>
    </li>
  );
}

export default async function TodayPage() {
  await requireUser();
  const [unmarked, undrafted, invoiceTotals, disputes, clinics] = await Promise.all([
    unmarkedByClinic(), undraftedPeriods(), openInvoiceTotals(), openDisputeSummary(), clinicHealth(),
  ]);

  const drafts = invoiceTotals.filter((t) => t.status === 'draft');
  const overdue = invoiceTotals.filter((t) => t.status === 'overdue');
  const count = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);

  const tasks: ReactNode[] = [];

  for (const u of unmarked) {
    const stopped = Number(u.unmarked_pct) >= STOPPED_PCT && Number(u.avg_days) >= STOPPED_DAYS;
    tasks.push(
      <Task
        key={`unmarked-${u.clinic_id}`}
        tone={stopped ? 'red' : 'amber'}
        title={`${plural(u.unmarked, 'appointment')} at ${u.name} ${u.unmarked === 1 ? 'has' : 'have'} no outcome`}
        detail={stopped
          ? `${u.unmarked_pct}% of its appointments in the last 90 days, ${u.avg_days} days old on average. The front desk looks to have stopped recording outcomes.`
          : `The oldest is ${age(u.oldest)} old.`}
        amount={u.value_cents > 0
          ? <>{money(u.value_cents, u.currency)}<span> if attended</span></>
          : <span>none would bill</span>}
        action={
          <Link
            className="btn btn-secondary btn-sm"
            href={qs('/appointments', { clinic: u.clinic_id, outcome: 'unmarked', from: isoDay(-90), to: isoDay(0) })}
          >
            Review
          </Link>
        }
      />,
    );
  }

  if (undrafted.length > 0) {
    tasks.push(
      <Task
        key="undrafted"
        tone="blue"
        title={`${plural(undrafted.length, 'clinic')} ${undrafted.length === 1 ? 'has' : 'have'} a closed period with no invoice`}
        detail={undrafted.map((u) => `${u.name} (${period(u.period_start, u.period_end)})`).join(', ')}
        amount={<>{moneyByCurrency(undrafted.map((u) => ({ currency: u.currency, cents: u.shows_cents })))}<span> in shows</span></>}
        action={
          <ActionForm action={draftInvoices} className="inline-form">
            <Submit size="sm">Draft invoices</Submit>
          </ActionForm>
        }
      />,
    );
  }

  if (drafts.length > 0) {
    tasks.push(
      <Task
        key="drafts"
        tone="blue"
        title={`${plural(count(drafts), 'draft invoice')} to review and send`}
        amount={moneyByCurrency(drafts)}
        action={<Link className="btn btn-secondary btn-sm" href="/invoices?status=draft">Review</Link>}
      />,
    );
  }

  if (overdue.length > 0) {
    tasks.push(
      <Task
        key="overdue"
        tone="red"
        title={`${plural(count(overdue), 'invoice')} unpaid more than ${NET_DAYS} days after sending`}
        amount={moneyByCurrency(overdue)}
        action={<Link className="btn btn-secondary btn-sm" href="/invoices?status=overdue">Review</Link>}
      />,
    );
  }

  if (disputes.count > 0 && disputes.oldest) {
    tasks.push(
      <Task
        key="disputes"
        tone="amber"
        title={`${plural(disputes.count, 'dispute')} waiting for a decision`}
        detail={`The oldest was raised ${age(disputes.oldest)} ago.`}
        action={<Link className="btn btn-secondary btn-sm" href="/disputes">Review</Link>}
      />,
    );
  }

  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: AGENCY_TZ,
  }).format(new Date());

  return (
    <>
      <PageHeader title="Today" meta={today} />

      <Section title="Needs attention">
        {tasks.length === 0
          ? <Empty>Nothing needs attention. Every past appointment has an outcome and every closed period is invoiced.</Empty>
          : <ul className="tasks">{tasks}</ul>}
      </Section>

      <Section title="Clinics, last 30 days">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Clinic</th>
                <th className="num">Rate</th>
                <th className="num">Attended</th>
                <th className="num">Show rate</th>
                <th className="num">Unmarked</th>
                <th className="num">Outstanding</th>
                <th className="num">Open disputes</th>
              </tr>
            </thead>
            <tbody>
              {clinics.map((c) => (
                <tr key={c.clinic_id}>
                  <td><Link href={`/clinics/${c.clinic_id}`}>{c.name}</Link></td>
                  <td className="num">{money(c.rate_cents, c.currency)}</td>
                  <td className="num">{c.attended}</td>
                  <td className="num">
                    {c.show_rate === null ? '—'
                      : Number(c.show_rate) < 55 ? <Badge tone="amber">{c.show_rate}%</Badge>
                      : `${c.show_rate}%`}
                  </td>
                  <td className="num">{c.unmarked || '—'}</td>
                  <td className="num">{c.outstanding_cents ? money(c.outstanding_cents, c.currency) : '—'}</td>
                  <td className="num">{c.open_disputes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
