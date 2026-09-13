import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Fragment } from 'react';
import { ActionForm, Submit } from '@/components/ActionForm';
import { PrintButton } from '@/components/client';
import { History } from '@/components/History';
import { PageHeader } from '@/components/ui';
import { recordPayment, refreshDraft, sendInvoice, voidInvoice } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import { AGENCY_TZ, NET_DAYS, addDays, money, period, plural, when } from '@/lib/format';
import { appliedCredits, getInvoice, invoiceLines, listActivity, type InvoiceLine } from '@/lib/queries';

export const metadata = { title: 'Invoice' };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const inv = await getInvoice(id);
  if (!inv) notFound();

  const [lines, credits, history] = await Promise.all([
    invoiceLines(id),
    appliedCredits(id),
    listActivity({ entity: 'invoice', entityId: id, limit: 100 }),
  ]);

  const inPeriod = lines.filter((l) => !l.late);
  const late = lines.filter((l) => l.late);
  const stamp = inv.overdue ? 'overdue' : inv.status;
  const due = inv.sent_at ? addDays(inv.sent_at, NET_DAYS) : null;
  const dateOnly = { time: false, year: true };

  const line = (l: InvoiceLine) => {
    const credited = l.outcome_source === 'dispute';
    return (
      <tr key={l.appointment_id} className={credited ? 'credited' : undefined}>
        <td>{when(l.starts_at, inv.timezone, { time: false })}</td>
        <td>
          <Link href={`/appointments/${encodeURIComponent(l.appointment_id)}`} className="mono">
            {l.patient_ref ?? l.appointment_id}
          </Link>
          {credited && <span className="muted"> {'·'} dispute upheld, credited later</span>}
        </td>
        <td>{l.is_new_patient ? 'New' : 'Returning'}</td>
        <td className="num mono">{money(l.rate_cents, inv.currency)}</td>
      </tr>
    );
  };

  return (
    <>
      <PageHeader
        back={{ href: '/invoices', label: 'Invoices' }}
        title={inv.number ?? 'Draft invoice'}
        meta={`${inv.clinic_name} · ${period(inv.period_start, inv.period_end)}`}
        actions={
          <div className="invoice-actions">
            {inv.status === 'draft' && (
              <>
                <ActionForm action={refreshDraft} className="inline-form">
                  <input type="hidden" name="invoice_id" value={inv.invoice_id} />
                  <Submit variant="secondary">Refresh draft</Submit>
                </ActionForm>
                <ActionForm action={sendInvoice} className="inline-form">
                  <input type="hidden" name="invoice_id" value={inv.invoice_id} />
                  <Submit>Send invoice</Submit>
                </ActionForm>
              </>
            )}
            {inv.status === 'sent' && (
              <ActionForm action={recordPayment} className="inline-form">
                <input type="hidden" name="invoice_id" value={inv.invoice_id} />
                <Submit>Record payment</Submit>
              </ActionForm>
            )}
            <PrintButton />
            {(inv.status === 'draft' || inv.status === 'sent') && (
              <details className="void-box">
                <summary className="btn btn-ghost">Void</summary>
                <div className="void-panel">
                  <ActionForm action={voidInvoice} className="form-grid">
                    <input type="hidden" name="invoice_id" value={inv.invoice_id} />
                    <p className="muted">Its shows and credits are released for the next draft. A paid invoice cannot be voided.</p>
                    <label className="field">
                      Reason
                      <input name="reason" required minLength={3} placeholder="Sent with the wrong period" />
                    </label>
                    <div><Submit variant="danger" size="sm">Void invoice</Submit></div>
                  </ActionForm>
                </div>
              </details>
            )}
          </div>
        }
      />

      <article className="sheet">
        <header className="sheet-head">
          <div className="sheet-issuer">
            <p className="wordmark">Pay Per Show</p>
            <p>Billed per patient who attends</p>
          </div>
          <div className="sheet-meta">
            <h1>{inv.number ?? 'Draft invoice'}</h1>
            <dl>
              <dt>Period</dt>
              <dd>{period(inv.period_start, inv.period_end)}</dd>
              <dt>Issued</dt>
              <dd>{inv.sent_at ? when(inv.sent_at, AGENCY_TZ, dateOnly) : 'Not sent'}</dd>
              {due && (
                <>
                  <dt>Due</dt>
                  <dd>{when(due, AGENCY_TZ, dateOnly)}</dd>
                </>
              )}
              {inv.paid_at && (
                <>
                  <dt>Paid</dt>
                  <dd>{when(inv.paid_at, AGENCY_TZ, dateOnly)}</dd>
                </>
              )}
            </dl>
          </div>
        </header>

        <div className="bill-to">
          <div>
            <p className="eyebrow">Bill to</p>
            <p className="bill-to-name"><Link href={`/clinics/${inv.clinic_id}`}>{inv.clinic_name}</Link></p>
          </div>
          <span className={`stamp stamp-${stamp}`}>{stamp}</span>
        </div>

        {inv.status === 'void' && (
          <p className="result is-error">
            Voided {when(inv.voided_at, AGENCY_TZ, dateOnly)}: {inv.void_reason}
          </p>
        )}
        {inv.status === 'draft' && (
          <p className="result is-ok no-print">
            Shows marked attended after this draft was made are added when you refresh it or send it.
          </p>
        )}

        <table className="lines">
          <thead>
            <tr>
              <th>Date</th>
              <th>Patient</th>
              <th>Type</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {late.length > 0 && inPeriod.length > 0 && (
              <tr className="group"><td colSpan={4}>Attended in {period(inv.period_start, inv.period_end)}</td></tr>
            )}
            {inPeriod.map(line)}
            {late.length > 0 && (
              <>
                <tr className="group"><td colSpan={4}>Marked late, from earlier periods</td></tr>
                {late.map(line)}
              </>
            )}
            {lines.length === 0 && (
              <tr><td colSpan={4} className="muted">No attended patients in this period.</td></tr>
            )}
          </tbody>
        </table>

        <dl className="totals">
          <dt>{plural(inv.shows_count, 'attended patient')}</dt>
          <dd>{money(inv.shows_cents, inv.currency)}</dd>
          {inv.minimum_topup_cents > 0 && (
            <>
              <dt>Top-up to the contract minimum</dt>
              <dd>{money(inv.minimum_topup_cents, inv.currency)}</dd>
            </>
          )}
          {credits.map((c) => (
            <Fragment key={c.credit_id}>
              <dt>
                Credit, {c.reason.toLowerCase()}
                {c.dispute_id && <> (<Link href={`/disputes/${c.dispute_id}`}>dispute #{c.dispute_id}</Link>)</>}
              </dt>
              <dd>{'−'}{money(c.amount_cents, inv.currency)}</dd>
            </Fragment>
          ))}
          <dt className="total-due">Total due</dt>
          <dd className="total-due">{money(inv.total_cents, inv.currency)}</dd>
        </dl>

        <p className="sheet-notes">
          Only patients who attended are charged. No-shows, cancellations and appointments without a recorded
          outcome are not billed. Payment is due within {NET_DAYS} days of the issue date.
        </p>
      </article>

      <section className="card no-print" style={{ marginTop: 16, maxWidth: 880 }}>
        <h2>History</h2>
        <History rows={history} />
      </section>
    </>
  );
}
