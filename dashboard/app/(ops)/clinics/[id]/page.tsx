import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, Submit } from '@/components/ActionForm';
import { Empty, Facts, InvoiceStatusBadge, PageHeader } from '@/components/ui';
import { setRate } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import { DASH, day, isoDay, money, period, qs, when } from '@/lib/format';
import { clinicCredits, clinicRates, getClinic, listInvoices } from '@/lib/queries';

export const metadata = { title: 'Clinic' };

function nextDay(value: string) {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default async function ClinicPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const c = await getClinic(id);
  if (!c) notFound();

  const [rates, credits, invoices] = await Promise.all([
    clinicRates(id), clinicCredits(id), listInvoices({ clinic: id }),
  ]);
  const tomorrow = nextDay(c.local_today);

  return (
    <>
      <PageHeader
        back={{ href: '/clinics', label: 'Clinics' }}
        title={c.name}
        meta={`${c.timezone} · ${c.billing_period === 'weekly' ? 'weekly' : 'monthly'} billing · contract since ${day(c.contract_start)}`}
        actions={
          <Link
            className="btn btn-secondary"
            href={qs('/appointments', { clinic: c.clinic_id, from: isoDay(-30), to: isoDay(14) })}
          >
            View appointments
          </Link>
        }
      />

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <h2>Contract</h2>
            <Facts
              items={[
                ['Rate per attended patient', money(c.rate_cents, c.currency)],
                ['Minimum per period', c.minimum_cents ? money(c.minimum_cents, c.currency) : 'None'],
                ['Returning patients', c.bills_returning ? 'Billed' : 'Not billed'],
                ['Billing period', c.billing_period === 'weekly' ? 'Weekly, Monday to Sunday' : 'Calendar month'],
                ['Currency', c.currency],
                ['Status', c.status[0].toUpperCase() + c.status.slice(1)],
              ]}
            />
          </section>

          <section className="card">
            <h2>Invoices</h2>
            {invoices.length === 0 ? (
              <Empty>No invoices yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Period</th>
                      <th className="num">Total</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.invoice_id}>
                        <td><Link href={`/invoices/${i.invoice_id}`} className="mono">{i.number ?? 'Draft'}</Link></td>
                        <td>{period(i.period_start, i.period_end)}</td>
                        <td className="num mono">{money(i.total_cents, i.currency)}</td>
                        <td><InvoiceStatusBadge status={i.status} overdue={i.overdue} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <h2>Rates</h2>
            <p className="muted">
              A show bills at the rate in force on its own date, so a new rate never changes the price of an
              appointment that has already happened.
            </p>
            <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th className="num">Rate</th>
                    <th>Set by</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.effective_from}>
                      <td>{day(r.effective_from)}</td>
                      <td className="num mono">{money(r.rate_cents, c.currency)}</td>
                      <td className="muted">{r.created_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ActionForm action={setRate} className="form-grid">
              <input type="hidden" name="clinic_id" value={c.clinic_id} />
              <label className="field">
                New rate ({c.currency})
                <input name="amount" inputMode="decimal" required placeholder="95.00" />
              </label>
              <label className="field">
                Takes effect on
                <input type="date" name="effective_from" min={tomorrow} defaultValue={tomorrow} required />
              </label>
              <div><Submit variant="secondary">Save rate</Submit></div>
            </ActionForm>
          </section>

          <section className="card">
            <h2>Credits</h2>
            {credits.length === 0 ? (
              <p className="muted">No credits.</p>
            ) : (
              <ul className="plain-list">
                {credits.map((cr) => (
                  <li key={cr.credit_id}>
                    <span className="mono">{money(cr.amount_cents, c.currency)}</span> {cr.reason.toLowerCase()}
                    {cr.dispute_id && <> (<Link href={`/disputes/${cr.dispute_id}`}>#{cr.dispute_id}</Link>)</>}
                    <span className="muted">
                      {' · '}
                      {cr.available_cents > 0 ? `${money(cr.available_cents, c.currency)} not yet applied` : 'fully applied'}
                      {' · '}
                      {when(cr.created_at, c.timezone, { time: false, year: true })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
