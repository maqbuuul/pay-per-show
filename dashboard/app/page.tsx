import Link from 'next/link';
import {
  getClinics, getDisputes, getShowRates, getSummary, getUnbilled, getUnmarked,
  money, parseRange, sortRows,
} from '@/lib/db';
import { ExportLink, FilterBar, SortTh, href, type Query } from '@/components/Controls';

export const dynamic = 'force-dynamic';

const AGENCY_TZ = process.env.AGENCY_TZ ?? 'America/New_York';

// A desk that has stopped recording shows up as a share of that clinic's own
// appointments, not as a raw count or an average age. Both thresholds apply.
const STOPPED_PCT = 8;
const STOPPED_DAYS = 7;

const stopped = (r: { unmarked_pct: string; avg_days_stale: string }) =>
  Number(r.unmarked_pct) >= STOPPED_PCT && Number(r.avg_days_stale) >= STOPPED_DAYS;

const day = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', timeZone: AGENCY_TZ,
      })
    : '—';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q: Query = {
    range: typeof sp.range === 'string' ? sp.range : undefined,
    clinic: typeof sp.clinic === 'string' ? sp.clinic : undefined,
    sort: typeof sp.sort === 'string' ? sp.sort : undefined,
    dir: typeof sp.dir === 'string' ? sp.dir : undefined,
    dstatus: typeof sp.dstatus === 'string' ? sp.dstatus : undefined,
  };

  const days = parseRange(q.range);
  const clinic = q.clinic ?? null;
  const dstatus = (q.dstatus === 'resolved' || q.dstatus === 'all' ? q.dstatus : 'open') as
    'open' | 'resolved' | 'all';

  const [clinics, s, unmarkedRaw, unbilledRaw, ratesRaw, disputes] = await Promise.all([
    getClinics(),
    getSummary(days, clinic),
    getUnmarked(days, clinic),
    getUnbilled(days, clinic),
    getShowRates(days, clinic),
    getDisputes(days, clinic, dstatus),
  ]);

  const unmarked = sortRows(unmarkedRaw, q.sort, q.dir,
    ['business_name', 'unmarked', 'revenue_at_risk_usd', 'unmarked_pct', 'avg_days_stale']);
  const unbilled = sortRows(unbilledRaw, q.sort, q.dir,
    ['business_name', 'shows', 'value_usd']);
  const rates = sortRows(ratesRaw, q.sort, q.dir,
    ['business_name', 'attended', 'no_shows', 'cancelled', 'unmarked', 'show_rate_pct']);

  const quiet = unmarked.filter(stopped);
  const selected = clinics.find((c) => c.clinic_id === clinic);

  return (
    <main>
      <header className="top">
        <div>
          <h1>Pay Per Show</h1>
          <p className="sub">
            Billing reconciliation
            {selected ? ` · ${selected.business_name}` : ' · all clinics'}
            {' · last '}{days === 365 ? '12 months' : `${days} days`}
          </p>
        </div>
        <span className="synthetic">Synthetic demo data</span>
      </header>

      <FilterBar base="/" q={q} days={days} clinics={clinics} clinic={clinic} />

      <section className="tiles">
        <div className="tile">
          <span className="label">Ready to invoice</span>
          <span className="figure">{money(s?.ready_usd)}</span>
          <span className="note">{s?.ready_shows ?? 0} attended, not yet billed</span>
        </div>
        <div className={`tile ${Number(s?.unmarked_usd) > 0 ? 'warn' : ''}`}>
          <span className="label">Not invoiced, no outcome</span>
          <span className="figure">{money(s?.unmarked_usd)}</span>
          <span className="note">{s?.unmarked ?? 0} appointments unmarked</span>
        </div>
        <div className={`tile ${quiet.length ? 'alert' : ''}`}>
          <span className="label">Front desks gone quiet</span>
          <span className="figure">{quiet.length}</span>
          <span className="note">
            {STOPPED_PCT}%+ unmarked, {STOPPED_DAYS}+ days old
          </span>
        </div>
        <div className="tile">
          <span className="label">Invoiced in range</span>
          <span className="figure">{money(s?.invoiced_usd)}</span>
          <span className="note">{s?.open_disputes ?? 0} open disputes</span>
        </div>
      </section>

      <section>
        <div className="shead">
          <h2>Appointments nobody marked</h2>
          <ExportLink q={q} table="unmarked" />
        </div>
        {unmarked.length === 0 ? (
          <p className="empty">Every past appointment in this range has an outcome.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <SortTh label="Clinic" col="business_name" base="/" q={q} />
                  <SortTh label="Unmarked" col="unmarked" base="/" q={q} numeric />
                  <SortTh label="Not invoiced" col="revenue_at_risk_usd" base="/" q={q} numeric />
                  <SortTh label="Share" col="unmarked_pct" base="/" q={q} numeric />
                  <SortTh label="Avg age" col="avg_days_stale" base="/" q={q} numeric />
                  <th />
                </tr>
              </thead>
              <tbody>
                {unmarked.map((r) => (
                  <tr key={r.clinic_id} className={stopped(r) ? 'row-alert' : ''}>
                    <td>
                      <Link href={href(`/clinic/${r.clinic_id}`, q, { outcome: 'unmarked' })}>
                        {r.business_name}
                      </Link>
                    </td>
                    <td className="n">{r.unmarked}</td>
                    <td className="n strong">{money(r.revenue_at_risk_usd)}</td>
                    <td className="n">{Number(r.unmarked_pct).toFixed(1)}%</td>
                    <td className="n dim">{Number(r.avg_days_stale).toFixed(0)}d</td>
                    <td className="flag">{stopped(r) ? 'stopped recording' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="shead">
          <h2>Ready to invoice</h2>
          <ExportLink q={q} table="unbilled" />
        </div>
        {unbilled.length === 0 ? (
          <p className="empty">Nothing billable and unbilled in this range.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <SortTh label="Clinic" col="business_name" base="/" q={q} />
                  <SortTh label="Shows" col="shows" base="/" q={q} numeric />
                  <SortTh label="Value" col="value_usd" base="/" q={q} numeric />
                  <th className="n">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {unbilled.map((r) => (
                  <tr key={r.clinic_id}>
                    <td>
                      <Link href={href(`/clinic/${r.clinic_id}`, q, { outcome: 'attended' })}>
                        {r.business_name}
                      </Link>
                    </td>
                    <td className="n">{r.shows}</td>
                    <td className="n strong">{money(r.value_usd)}</td>
                    <td className="n dim">{day(r.oldest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="shead">
          <h2>Show rate</h2>
          <ExportLink q={q} table="showrate" />
        </div>
        <p className="sub">
          Attended over attended plus no-show. Cancellations and unmarked are shown
          but excluded from the rate.
        </p>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <SortTh label="Clinic" col="business_name" base="/" q={q} />
                <SortTh label="Attended" col="attended" base="/" q={q} numeric />
                <SortTh label="No-show" col="no_shows" base="/" q={q} numeric />
                <SortTh label="Cancelled" col="cancelled" base="/" q={q} numeric />
                <SortTh label="Unmarked" col="unmarked" base="/" q={q} numeric />
                <SortTh label="Show rate" col="show_rate_pct" base="/" q={q} numeric />
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => {
                const pct = r.show_rate_pct === null ? null : Number(r.show_rate_pct);
                const poor = pct !== null && pct < 55;
                return (
                  <tr key={r.clinic_id} className={poor ? 'row-warn' : ''}>
                    <td>
                      <Link href={href(`/clinic/${r.clinic_id}`, q, { outcome: undefined })}>
                        {r.business_name}
                      </Link>
                    </td>
                    <td className="n">{r.attended}</td>
                    <td className="n">{r.no_shows}</td>
                    <td className="n dim">{r.cancelled || '—'}</td>
                    <td className="n dim">{r.unmarked || '—'}</td>
                    <td className="n strong">{pct === null ? '—' : `${pct.toFixed(1)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="shead">
          <h2>Disputes</h2>
          <div className="segmented">
            {(['open', 'resolved', 'all'] as const).map((v) => (
              <Link
                key={v}
                href={href('/', q, { dstatus: v })}
                className={`chip ${dstatus === v ? 'on' : ''}`}
              >
                {v}
              </Link>
            ))}
            <ExportLink q={q} table="disputes" />
          </div>
        </div>
        {disputes.length === 0 ? (
          <p className="empty">No {dstatus === 'all' ? '' : dstatus} disputes in this range.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Clinic</th>
                  <th>Raised</th>
                  <th>By</th>
                  <th>Reason</th>
                  <th>Resolution</th>
                  <th>Appointment</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => (
                  <tr key={d.dispute_id}>
                    <td>
                      <Link href={href(`/clinic/${d.clinic_id}`, q, {})}>{d.business_name}</Link>
                    </td>
                    <td className="dim">{day(d.raised_at)}</td>
                    <td className="dim">{d.raised_by}</td>
                    <td>{d.reason}</td>
                    <td>
                      {d.resolution ? (
                        <span className={`badge ${d.resolution}`}>{d.resolution}</span>
                      ) : (
                        <span className="badge open">open</span>
                      )}
                    </td>
                    <td className="mono dim">{d.appointment_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer>
        Read-only. Invoices and outcome changes are written by the n8n workflows,
        where they are logged and idempotent. Figures are generated demo data, not
        a real client account.
      </footer>
    </main>
  );
}
