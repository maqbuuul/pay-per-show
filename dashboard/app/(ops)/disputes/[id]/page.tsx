import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, Submit } from '@/components/ActionForm';
import { History } from '@/components/History';
import { BillingBadge, DisputeBadge, Facts, OutcomeBadge, PageHeader } from '@/components/ui';
import { resolveDispute } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import { DASH, RESOLUTION, label, money, when } from '@/lib/format';
import { creditUse, getDispute, listActivity } from '@/lib/queries';

export const metadata = { title: 'Dispute' };

const SOURCE: Record<string, string> = {
  calendar: 'from the calendar',
  manual: 'by hand',
  dispute: 'through a dispute',
};

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const d = await getDispute(id);
  if (!d) notFound();

  const [use, history] = await Promise.all([
    d.credit_id ? creditUse(d.credit_id) : Promise.resolve([]),
    listActivity({ entity: 'dispute', entityId: id, limit: 100 }),
  ]);

  const e = d.evidence;
  const amount = money(d.rate_cents, d.currency);
  const onSentInvoice = d.invoice_status === 'sent' || d.invoice_status === 'paid';

  // What each choice does to this particular show.
  const choices = onSentInvoice
    ? [
        ['upheld', 'Uphold: the patient did not attend',
          `Records a no-show and credits ${amount} on ${d.clinic_name}'s next invoice. ${d.invoice_number} itself does not change.`],
        ['goodwill', 'Goodwill credit: the evidence is unclear',
          `Credits ${amount} on the next invoice. The appointment stays marked attended.`],
        ['rejected', 'Reject: the evidence shows the patient attended',
          `Nothing changes. ${d.invoice_number} stands and no credit is issued.`],
      ]
    : [
        ['upheld', 'Uphold: the patient did not attend',
          'Records a no-show. The show will not be billed.'],
        ['goodwill', 'Goodwill: the evidence is unclear',
          'Writes the show off. It will not be billed, and no credit is issued.'],
        ['rejected', 'Reject: the evidence shows the patient attended',
          `The show goes back on the next invoice at ${amount}.`],
      ];

  const creditUsed = use.reduce((n, u) => n + u.amount_cents, 0);

  return (
    <>
      <PageHeader
        back={{ href: '/disputes', label: 'Disputes' }}
        title={`Dispute #${d.dispute_id}`}
        meta={`${d.clinic_name} · raised ${when(d.raised_at, d.timezone, { year: true })} by ${d.raised_by}`}
        actions={<DisputeBadge resolution={d.resolution} />}
      />

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <h2>Reason given</h2>
            <p>{d.reason}</p>
          </section>

          <section className="card">
            <h2>Evidence when the dispute was raised</h2>
            <Facts
              items={[
                ['Appointment', <Link href={`/appointments/${encodeURIComponent(d.appointment_id)}`}>{when(d.starts_at, d.timezone, { year: true, zone: true })}</Link>],
                ['Booked by', e.booked_by === 'agent' ? 'AI agent' : e.booked_by === 'staff' ? 'Clinic staff' : DASH],
                ['Booked on', e.booked_at ? when(String(e.booked_at), d.timezone, { year: true }) : DASH],
                ['Marked attended', e.outcome_at
                  ? `${when(String(e.outcome_at), d.timezone, { year: true })}, ${SOURCE[String(e.outcome_source)] ?? ''} by ${e.outcome_by}`
                  : DASH],
                ['Billed at', e.rate_cents ? money(Number(e.rate_cents), d.currency) : DASH],
                ['On invoice', e.invoice_number ? String(e.invoice_number) : 'Not yet invoiced'],
              ]}
            />
          </section>

          <section className="card">
            <h2>History</h2>
            <History rows={history} />
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <h2>The show now</h2>
            <p>
              <OutcomeBadge outcome={d.outcome} /> <BillingBadge billing={d.billing} />
            </p>
            <p className="muted">
              {d.invoice_id
                ? <>On <Link href={`/invoices/${d.invoice_id}`}>{d.invoice_number ?? 'a draft invoice'}</Link>, {amount}.</>
                : 'Not on an invoice while the dispute is open.'}
            </p>
          </section>

          {d.resolution ? (
            <section className="card">
              <h2>Resolution</h2>
              <Facts
                items={[
                  ['Decision', label(RESOLUTION, d.resolution)],
                  ['Decided', `${when(d.resolved_at, d.timezone, { year: true })} by ${d.resolved_by}`],
                  ['Note', d.note ?? DASH],
                  ['Credit', d.credit_cents ? money(d.credit_cents, d.currency) : 'None'],
                ]}
              />
              {d.credit_id && d.credit_cents && (
                <p className="muted" style={{ marginTop: 12 }}>
                  {use.length === 0
                    ? 'Not applied yet. It comes off the next invoice.'
                    : <>Applied to {use.map((u, i) => (
                        <span key={u.invoice_id}>
                          {i > 0 && ', '}
                          <Link href={`/invoices/${u.invoice_id}`}>{u.number ?? 'a draft'}</Link> ({money(u.amount_cents, d.currency)})
                        </span>
                      ))}.{creditUsed < d.credit_cents && ` ${money(d.credit_cents - creditUsed, d.currency)} left to apply.`}</>}
                </p>
              )}
            </section>
          ) : (
            <section className="card">
              <h2>Resolve</h2>
              <ActionForm action={resolveDispute} className="form-grid">
                <input type="hidden" name="dispute_id" value={d.dispute_id} />
                <fieldset className="choices">
                  <legend className="sr-only">Decision</legend>
                  {choices.map(([value, title, effect]) => (
                    <label key={value} className="choice">
                      <input type="radio" name="resolution" value={value} required />
                      <span>
                        <span className="choice-title">{title}</span>
                        <span className="choice-effect">{effect}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <label className="field">
                  Note
                  <textarea name="note" placeholder="What confirmed it, for the record" />
                </label>
                <div><Submit>Resolve dispute</Submit></div>
              </ActionForm>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
