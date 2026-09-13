import Link from 'next/link';
import { DisputeBadge, Empty, PageHeader, Tabs } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { DASH, age, money, param, when } from '@/lib/format';
import { disputeCounts, listDisputes } from '@/lib/queries';

export const metadata = { title: 'Disputes' };

export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const resolved = param(await searchParams, 'status') === 'resolved';
  const [rows, counts] = await Promise.all([listDisputes({ open: !resolved }), disputeCounts()]);

  return (
    <>
      <PageHeader
        title="Disputes"
        meta="A clinic says a patient on an invoice did not attend. Each dispute keeps the evidence as it stood when it was raised."
      />
      <Tabs
        items={[
          { href: '/disputes', label: 'Open', count: counts.open, active: !resolved },
          { href: '/disputes?status=resolved', label: 'Resolved', count: counts.resolved, active: resolved },
        ]}
      />

      {rows.length === 0 ? (
        <Empty>{resolved ? 'No resolved disputes yet.' : 'No disputes are waiting for a decision.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Dispute</th>
                <th>Raised</th>
                <th>{resolved ? 'Resolved' : 'Waiting'}</th>
                <th>Clinic</th>
                <th>Appointment</th>
                <th>Reason</th>
                <th className="num">Amount</th>
                <th>Invoice</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.dispute_id}>
                  <td><Link href={`/disputes/${d.dispute_id}`}>#{d.dispute_id}</Link></td>
                  <td className="muted">{when(d.raised_at, d.timezone, { time: false })}</td>
                  <td className="muted">
                    {d.resolved_at ? when(d.resolved_at, d.timezone, { time: false }) : age(d.raised_at)}
                  </td>
                  <td>{d.clinic_name}</td>
                  <td>{when(d.starts_at, d.timezone)}</td>
                  <td className="wrap">{d.reason}</td>
                  <td className="num mono">{d.rate_cents ? money(d.rate_cents, d.currency) : DASH}</td>
                  <td>
                    {d.invoice_id
                      ? <Link href={`/invoices/${d.invoice_id}`} className="mono">{d.invoice_number ?? 'Draft'}</Link>
                      : DASH}
                  </td>
                  <td><DisputeBadge resolution={d.resolution} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
