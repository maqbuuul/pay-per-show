import Link from 'next/link';
import { ActionForm, Submit } from '@/components/ActionForm';
import { Empty, InvoiceStatusBadge, PageHeader, Tabs } from '@/components/ui';
import { draftInvoices } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import { AGENCY_TZ, DASH, NET_DAYS, addDays, money, oneOf, param, period, qs, when } from '@/lib/format';
import { INVOICE_STATUSES, invoiceCounts, listInvoices } from '@/lib/queries';

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const status = oneOf(param(await searchParams, 'status'), INVOICE_STATUSES);
  const [rows, counts] = await Promise.all([listInvoices({ status }), invoiceCounts()]);

  const tab = (value: (typeof INVOICE_STATUSES)[number] | undefined, text: string) => ({
    href: qs('/invoices', { status: value }),
    label: text,
    count: counts[value ?? 'all'],
    active: status === value,
  });

  return (
    <>
      <PageHeader
        title="Invoices"
        meta={`Payment is due ${NET_DAYS} days after an invoice is sent.`}
        actions={
          <ActionForm action={draftInvoices} className="inline-form">
            <Submit>Draft invoices for closed periods</Submit>
          </ActionForm>
        }
      />

      <Tabs
        items={[
          tab(undefined, 'All'),
          tab('draft', 'Drafts'),
          tab('sent', 'Sent'),
          tab('overdue', 'Overdue'),
          tab('paid', 'Paid'),
          tab('void', 'Void'),
        ]}
      />

      {rows.length === 0 ? (
        <Empty>No invoices here.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Clinic</th>
                <th>Period</th>
                <th className="num">Shows</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Sent</th>
                <th>Due or paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.invoice_id}>
                  <td><Link href={`/invoices/${i.invoice_id}`} className="mono">{i.number ?? 'Draft'}</Link></td>
                  <td>{i.clinic_name}</td>
                  <td>{period(i.period_start, i.period_end)}</td>
                  <td className="num">{i.shows_count}</td>
                  <td className="num mono">{money(i.total_cents, i.currency)}</td>
                  <td><InvoiceStatusBadge status={i.status} overdue={i.overdue} /></td>
                  <td className="muted">{i.sent_at ? when(i.sent_at, AGENCY_TZ, { time: false }) : DASH}</td>
                  <td className="muted">
                    {i.paid_at
                      ? `Paid ${when(i.paid_at, AGENCY_TZ, { time: false })}`
                      : i.status === 'sent' && i.sent_at
                        ? `Due ${when(addDays(i.sent_at, NET_DAYS), AGENCY_TZ, { time: false })}`
                        : DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
