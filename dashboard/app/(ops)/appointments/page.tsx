import Link from 'next/link';
import { ActionForm, Submit } from '@/components/ActionForm';
import { SelectAll } from '@/components/client';
import { Badge, BillingBadge, Empty, OutcomeBadge, PageHeader, Pager } from '@/components/ui';
import { markOutcomes } from '@/lib/actions';
import { requireUser } from '@/lib/auth';
import {
  BILLING, DASH, OUTCOME, isoDay, money, oneOf, pageNumber, param, qs, validDay, when,
} from '@/lib/format';
import { BILLINGS, OUTCOMES, PAGE_SIZE, clinicOptions, listAppointments } from '@/lib/queries';

export const metadata = { title: 'Appointments' };

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;

  const filters = {
    clinic: param(sp, 'clinic'),
    outcome: oneOf(param(sp, 'outcome'), OUTCOMES),
    billing: oneOf(param(sp, 'billing'), BILLINGS),
    from: validDay(param(sp, 'from')) ?? isoDay(-30),
    to: validDay(param(sp, 'to')) ?? isoDay(14),
    q: param(sp, 'q'),
    page: pageNumber(param(sp, 'page')),
  };

  const [rows, clinics] = await Promise.all([listAppointments(filters), clinicOptions()]);
  const total = rows[0]?.total ?? 0;
  const query = { ...filters, page: undefined };

  return (
    <>
      <PageHeader
        title="Appointments"
        meta={`${total.toLocaleString('en-US')} matching. Times are shown in each clinic's own timezone.`}
      />

      <form className="filters" method="get" action="/appointments">
        <label>
          Clinic
          <select name="clinic" defaultValue={filters.clinic ?? ''}>
            <option value="">All clinics</option>
            {clinics.map((c) => <option key={c.clinic_id} value={c.clinic_id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          Outcome
          <select name="outcome" defaultValue={filters.outcome ?? ''}>
            <option value="">Any</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME[o]}</option>)}
          </select>
        </label>
        <label>
          Billing
          <select name="billing" defaultValue={filters.billing ?? ''}>
            <option value="">Any</option>
            {BILLINGS.map((b) => <option key={b} value={b}>{BILLING[b]}</option>)}
          </select>
        </label>
        <label>
          From
          <input type="date" name="from" defaultValue={filters.from} />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={filters.to} />
        </label>
        <label className="grow">
          Search
          <input type="search" name="q" defaultValue={filters.q ?? ''} placeholder="Appointment or patient reference" />
        </label>
        <button type="submit" className="btn btn-secondary">Apply</button>
        <Link href="/appointments" className="btn btn-ghost">Clear</Link>
      </form>

      {rows.length === 0 ? (
        <Empty>No appointments match these filters.</Empty>
      ) : (
        <ActionForm action={markOutcomes} className="bulk" resultFirst>
          <div className="bulk-bar">
            <span className="muted">Mark selected as</span>
            {OUTCOMES.map((o) => (
              <Submit key={o} name="outcome" value={o} variant="secondary" size="sm">{OUTCOME[o]}</Submit>
            ))}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check"><SelectAll /></th>
                  <th>When</th>
                  <th>Clinic</th>
                  <th>Patient</th>
                  <th>Type</th>
                  <th>Booked by</th>
                  <th>Outcome</th>
                  <th>Billing</th>
                  <th className="num">Rate</th>
                  <th>Invoice</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const locked = r.invoice_status === 'sent' || r.invoice_status === 'paid' || r.billing === 'written_off';
                  return (
                    <tr key={r.appointment_id}>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          name="ids"
                          value={r.appointment_id}
                          disabled={locked}
                          title={locked ? 'Locked by a sent invoice or a dispute' : undefined}
                          aria-label={`Select appointment ${r.appointment_id}`}
                        />
                      </td>
                      <td>
                        <Link href={`/appointments/${encodeURIComponent(r.appointment_id)}`}>
                          {when(r.starts_at, r.timezone, { zone: true })}
                        </Link>
                      </td>
                      <td>{r.clinic_name}</td>
                      <td className="mono">{r.patient_ref ?? DASH}</td>
                      <td>{r.is_new_patient ? 'New' : 'Returning'}</td>
                      <td className="muted">{r.booked_by === 'agent' ? 'AI agent' : r.booked_by === 'staff' ? 'Staff' : DASH}</td>
                      <td>
                        <OutcomeBadge outcome={r.outcome} />
                        {r.disputed && <Badge tone="red">Disputed</Badge>}
                      </td>
                      <td><BillingBadge billing={r.billing} /></td>
                      <td className="num">{r.rate_cents ? money(r.rate_cents, r.currency) : DASH}</td>
                      <td>
                        {r.invoice_id
                          ? <Link href={`/invoices/${r.invoice_id}`} className="mono">{r.invoice_number ?? 'Draft'}</Link>
                          : DASH}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ActionForm>
      )}

      <Pager
        page={filters.page}
        total={total}
        size={PAGE_SIZE}
        href={(p) => qs('/appointments', { ...query, page: p > 0 ? p + 1 : undefined })}
      />
    </>
  );
}
