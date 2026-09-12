import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  countEvents, getClinics, getDisputes, getEvents, getInvoices, getShowRates,
  getUnmarked, money, parseRange, sortRows, PAGE_SIZE, RANGES,
} from '@/lib/db';
import { ExportLink, SortTh, href, type Query } from '@/components/Controls';

export const dynamic = 'force-dynamic';

const AGENCY_TZ = process.env.AGENCY_TZ ?? 'America/New_York';

const OUTCOMES = ['attended', 'no_show', 'cancelled', 'unmarked'] as const;

const dt = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        timeZone: AGENCY_TZ,
      })
    : '—';

export default async function ClinicPage({
  params, searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { clinicId } = await params;
  const sp = await searchParams;

  const q: Query = {
    range: typeof sp.range === 'string' ? sp.range : undefined,
    outcome: typeof sp.outcome === 'string' ? sp.outcome : undefined,
    sort: typeof sp.sort === 'string' ? sp.sort : undefined,
    dir: typeof sp.dir === 'string' ? sp.dir : undefined,
    page: typeof sp.page === 'string' ? sp.page : undefined,
  };

  const days = parseRange(q.range);
  const outcome = (OUTCOMES as readonly string[]).includes(q.outcome ?? '')
    ? (q.outcome as string)
    : null;
  const page = Math.max(0, Number(q.page) || 0);

  const clinics = await getClinics();
  const clinic = clinics.find((c) => c.clinic_id === clinicId);
  if (!clinic) notFound();

  const [eventsRaw, total, rates, unmarked, invoices, disputes] = await Promise.all([
    getEvents(clinicId, days, outcome, page),
    countEvents(clinicId, days, outcome),
    getShowRates(days, clinicId),
    getUnmarked(days, clinicId),
    getInvoices(clinicId),
    getDisputes(days, clinicId, 'all'),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  const events = sortRows(eventsRaw, q.sort, q.dir,
    ['starts_at', 'outcome', 'state', 'rate_cents', 'booked_at']);

  const r = rates[0];
  const u = unmarked[0];
  const base = `/clinic/${clinicId}`;
  // The drill-down query carries `clinic` so Back lands on the filtered overview.
  const backQ: Query = { range: q.range, clinic: clinicId };

  return (
    <main>
      <header className="top">
        <div>
          <Link href={href('/', backQ, {})} className="back">
            {'←'} All clinics
          </Link>
          <h1>{clinic.business_name}</h1>
          <p className="sub">
            {money(clinic.rate_per_show_cents / 100)} per show {'·'} {clinic.status}
            {clinic.bills_returning ? ' · bills returning patients' : ' · new patients only'}
          </p>
        </div>
        <span className="synthetic">Synthetic demo data</span>
      </header>

      <div className="filters">
        <div className="fgroup">
          <span className="flabel">Range</span>
          {RANGES.map((v) => (
            <Link
              key={v}
              href={href(base, q, { range: String(v), page: undefined })}
              className={`chip ${v === days ? 'on' : ''}`}
            >
              {v === 365 ? '12m' : `${v}d`}
            </Link>
          ))}
        </div>
        <div className="fgroup">
          <span className="flabel">Outcome</span>
          <Link
            href={href(base, q, { outcome: undefined, page: undefined })}
            className={`chip ${!outcome ? 'on' : ''}`}
          >
            All
          </Link>
          {OUTCOMES.map((o) => (
            <Link
              key={o}
              href={href(base, q, { outcome: o, page: undefined })}
              className={`chip ${outcome === o ? 'on' : ''}`}
            >
              {o.replace('_', '-')}
            </Link>
          ))}
        </div>
      </div>

      <section className="tiles">
        <div className="tile">
          <span className="label">Show rate</span>
          <span className="figure">
            {r?.show_rate_pct === null || r === undefined
              ? '—'
              : `${Number(r.show_rate_pct).toFixed(1)}%`}
          </span>
          <span className="note">{r?.attended ?? 0} of {r?.resolved ?? 0} resolved</span>
        </div>
        <div className={`tile ${Number(u?.unmarked ?? 0) > 0 ? 'warn' : ''}`}>
          <span className="label">Unmarked</span>
          <span className="figure">{u?.unmarked ?? 0}</span>
          <span className="note">
            {u ? `${money(u.revenue_at_risk_usd)} not invoiced` : 'nothing outstanding'}
          </span>
        </div>
        <div className="tile">
          <span className="label">No-shows</span>
          <span className="figure">{r?.no_shows ?? 0}</span>
          <span className="note">{r?.cancelled ?? 0} cancelled in advance</span>
        </div>
        <div className="tile">
          <span className="label">Disputes</span>
          <span className="figure">{disputes.length}</span>
          <span className="note">
            {disputes.filter((d) => d.resolution === 'upheld').length} upheld
          </span>
        </div>
      </section>

      <section>
        <div className="shead">
          <h2>
            Appointments
            <span className="count">
              {total === 0 ? 'none' : `${from}–${to} of ${total}`}
            </span>
          </h2>
          <ExportLink q={{ ...q, clinic: clinicId, page: undefined }} table="events" />
        </div>
        {pages > 1 && q.sort && (
          <p className="sub">
            Sorting applies to this page. Narrow the range or outcome to sort the
            whole set, or export the CSV.
          </p>
        )}
        {events.length === 0 ? (
          <p className="empty">No appointments match these filters.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <SortTh label="Starts" col="starts_at" base={base} q={q} />
                  <SortTh label="Outcome" col="outcome" base={base} q={q} />
                  <th>Marked</th>
                  <th>Source</th>
                  <SortTh label="State" col="state" base={base} q={q} />
                  <SortTh label="Rate" col="rate_cents" base={base} q={q} numeric />
                  <th>Invoice</th>
                  <th>Appointment</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.appointment_id} className={e.outcome === 'unmarked' ? 'row-alert' : ''}>
                    <td>{dt(e.starts_at)}</td>
                    <td><span className={`badge ${e.outcome}`}>{e.outcome.replace('_', '-')}</span></td>
                    <td className="dim">{dt(e.outcome_at)}</td>
                    <td className="dim">{e.outcome_source ?? '—'}</td>
                    <td className="dim">{e.state}</td>
                    <td className="n">{e.rate_cents ? money(e.rate_cents / 100) : '—'}</td>
                    <td className="mono dim">{e.invoice_id ?? '—'}</td>
                    <td className="mono dim">{e.appointment_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav className="pager">
            <Link
              href={href(base, q, { page: page > 1 ? String(page - 1) : undefined })}
              className={`chip ${page === 0 ? 'off' : ''}`}
              aria-disabled={page === 0}
            >
              {'←'} Previous
            </Link>
            <span className="dim">Page {page + 1} of {pages}</span>
            <Link
              href={href(base, q, { page: String(page + 1) })}
              className={`chip ${page + 1 >= pages ? 'off' : ''}`}
              aria-disabled={page + 1 >= pages}
            >
              Next {'→'}
            </Link>
          </nav>
        )}
      </section>

      <section>
        <h2>Invoices</h2>
        {invoices.length === 0 ? (
          <p className="empty">No invoices generated for this clinic.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Period</th>
                  <th className="n">Shows</th>
                  <th className="n">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.invoice_id}>
                    <td className="mono">{i.invoice_id}</td>
                    <td className="dim">
                      {new Date(i.period_start).toLocaleDateString('en-GB',
                        { day: 'numeric', month: 'short', timeZone: 'UTC' })}
                      {' – '}
                      {new Date(i.period_end).toLocaleDateString('en-GB',
                        { day: 'numeric', month: 'short', timeZone: 'UTC' })}
                    </td>
                    <td className="n">{i.shows_count}</td>
                    <td className="n strong">{money(i.total_cents / 100)}</td>
                    <td><span className={`badge ${i.status}`}>{i.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {disputes.length > 0 && (
        <section>
          <h2>Disputes</h2>
          <p className="sub">
            The evidence is what the appointment looked like when it was marked:
            who booked it, which sync set the outcome, and when. Without it a
            dispute weeks later is one person&apos;s word against another&apos;s.
          </p>
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Raised</th>
                  <th>By</th>
                  <th>Reason</th>
                  <th>Evidence at time of marking</th>
                  <th>Resolution</th>
                  <th>Appointment</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => (
                  <tr key={d.dispute_id}>
                    <td className="dim">{dt(d.raised_at)}</td>
                    <td className="dim">{d.raised_by}</td>
                    <td>{d.reason}</td>
                    <td>
                      {d.evidence ? (
                        <dl className="evidence">
                          {Object.entries(d.evidence).map(([k, v]) => (
                            <div key={k}>
                              <dt>{k.replace(/_/g, ' ')}</dt>
                              <dd>
                                {v === null || v === ''
                                  ? '—'
                                  : /^\d{4}-\d{2}-\d{2}T/.test(String(v))
                                    ? dt(String(v))
                                    : String(v)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <span className="dim">none recorded</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${d.resolution ?? 'open'}`}>
                        {d.resolution ?? 'open'}
                      </span>
                      {d.note && <div className="dim note-sm">{d.note}</div>}
                    </td>
                    <td className="mono dim">{d.appointment_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
