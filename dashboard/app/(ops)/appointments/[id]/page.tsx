import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, Submit } from '@/components/ActionForm';
import { History } from '@/components/History';
import { BillingBadge, DisputeBadge, Facts, OutcomeBadge, PageHeader } from '@/components/ui';
import { markOutcomes, raiseDispute } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import { DASH, OUTCOME, money, when } from '@/lib/format';
import { OUTCOMES, getAppointment, listActivity, listDisputes } from '@/lib/queries';

export const metadata = { title: 'Appointment' };

const SOURCE: Record<string, string> = {
  calendar: 'from the calendar',
  manual: 'marked by hand',
  dispute: 'through a dispute',
};

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const id = decodeURIComponent((await params).id);
  const a = await getAppointment(id);
  if (!a) notFound();

  const [disputes, history] = await Promise.all([
    listDisputes({ appointment: id }),
    listActivity({ entity: 'appointment', entityId: id, limit: 100 }),
  ]);

  const locked = a.invoice_status === 'sent' || a.invoice_status === 'paid';
  const future = new Date(a.starts_at).getTime() > Date.now();
  const hasOpenDispute = disputes.some((d) => !d.resolution);
  const canDispute = a.outcome === 'attended' && ['billable', 'invoiced'].includes(a.billing) && !hasOpenDispute;

  return (
    <>
      <PageHeader
        back={{ href: '/appointments', label: 'Appointments' }}
        title={a.clinic_name}
        meta={<>{when(a.starts_at, a.timezone, { year: true, zone: true })} {'·'} <span className="mono">{a.appointment_id}</span></>}
        actions={<><OutcomeBadge outcome={a.outcome} /><BillingBadge billing={a.billing} /></>}
      />

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <h2>Details</h2>
            <Facts
              items={[
                ['Patient', <span className="mono">{a.patient_ref ?? DASH}</span>],
                ['Patient type', a.is_new_patient ? 'New patient' : 'Returning patient'],
                ['Booked by', a.booked_by === 'agent' ? 'AI agent' : a.booked_by === 'staff' ? 'Clinic staff' : DASH],
                ['Booked on', when(a.booked_at, a.timezone, { year: true })],
                ['Outcome recorded', a.outcome_at
                  ? `${when(a.outcome_at, a.timezone, { year: true })}, ${SOURCE[a.outcome_source ?? ''] ?? ''} by ${a.outcome_by}`
                  : DASH],
                ['Rate', a.rate_cents ? money(a.rate_cents, a.currency) : DASH],
                ['Invoice', a.invoice_id
                  ? <Link href={`/invoices/${a.invoice_id}`}>{a.invoice_number ?? 'Draft invoice'}</Link>
                  : DASH],
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
            <h2>Outcome</h2>
            {locked ? (
              <p className="muted">
                This appointment is on sent invoice {a.invoice_number}. Its outcome can only change through a dispute.
              </p>
            ) : a.billing === 'written_off' ? (
              <p className="muted">This show was written off through a dispute and cannot be changed.</p>
            ) : (
              <ActionForm action={markOutcomes}>
                <input type="hidden" name="ids" value={a.appointment_id} />
                {future && <p className="muted">This appointment has not happened yet, so it can only be cancelled.</p>}
                <div className="button-row">
                  {OUTCOMES.filter((o) => o !== a.outcome).map((o) => (
                    <Submit
                      key={o}
                      name="outcome"
                      value={o}
                      variant="secondary"
                      size="sm"
                      disabled={future && (o === 'attended' || o === 'no_show')}
                    >
                      Mark {OUTCOME[o].toLowerCase()}
                    </Submit>
                  ))}
                </div>
              </ActionForm>
            )}
          </section>

          <section className="card">
            <h2>Disputes</h2>
            {disputes.length > 0 && (
              <ul className="plain-list">
                {disputes.map((d) => (
                  <li key={d.dispute_id}>
                    <Link href={`/disputes/${d.dispute_id}`}>Dispute #{d.dispute_id}</Link>{' '}
                    <DisputeBadge resolution={d.resolution} />
                    <span className="muted"> raised {when(d.raised_at, a.timezone)}</span>
                  </li>
                ))}
              </ul>
            )}
            {canDispute ? (
              <ActionForm action={raiseDispute} className="form-grid">
                <input type="hidden" name="appointment_id" value={a.appointment_id} />
                <label className="field">
                  Raised by
                  <input name="raised_by" defaultValue={`${a.clinic_name} front desk`} required />
                </label>
                <label className="field">
                  Reason the clinic gave
                  <textarea name="reason" required placeholder="Patient did not attend" />
                </label>
                <div><Submit variant="secondary">Open dispute</Submit></div>
              </ActionForm>
            ) : (
              !hasOpenDispute && disputes.length === 0 && (
                <p className="muted">Only an attended show that bills can be disputed.</p>
              )
            )}
          </section>
        </div>
      </div>
    </>
  );
}
