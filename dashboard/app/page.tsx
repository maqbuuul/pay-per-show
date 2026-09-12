import {
  getUnmarked, getUnbilled, getShowRates, getOpenDisputes, money, sum,
} from '@/lib/db';

// Always fresh. A billing figure cached for an hour is a billing figure
// somebody quotes to a client wrongly.
export const dynamic = 'force-dynamic';

// A front desk that has stopped recording is not the same as one with a few
// stragglers. Every clinic has stragglers, and ranking by raw count just ranks
// clinics by size. So this needs BOTH: a material share of the clinic's own
// appointments, and enough age that it is not simply this week's paperwork.
// Vercel runs in UTC. Rendering the date in the server's zone puts the header
// a day behind whoever is reading it for most of their working evening, and a
// billing page that cannot agree with you about what day it is does not get
// believed about the money either.
const AGENCY_TZ = process.env.AGENCY_TZ ?? 'America/New_York';

const STOPPED_PCT  = 8;   // % of that clinic's past appointments left unmarked
const STOPPED_DAYS = 7;   // averaging at least a week old

const hasStopped = (r: { unmarked_pct: string; avg_days_stale: string }) =>
  Number(r.unmarked_pct) >= STOPPED_PCT && Number(r.avg_days_stale) >= STOPPED_DAYS;

export default async function Page() {
  const [unmarked, unbilled, rates, disputes] = await Promise.all([
    getUnmarked(), getUnbilled(), getShowRates(), getOpenDisputes(),
  ]);

  const atRisk = sum(unmarked, 'revenue_at_risk_usd');
  const unmarkedCount = sum(unmarked, 'unmarked');
  const readyToBill = sum(unbilled, 'value_usd');
  const stopped = unmarked.filter(hasStopped);

  return (
    <main>
      <header className="top">
        <h1>Pay Per Show</h1>
        <p>Billing reconciliation · {new Date().toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric', timeZone: AGENCY_TZ,
        })}</p>
      </header>

      <section className="tiles">
        <div className="tile">
          <span className="label">Ready to invoice</span>
          <span className="figure">{money(readyToBill)}</span>
          <span className="note">{sum(unbilled, 'shows')} attended, not yet billed</span>
        </div>
        <div className={`tile ${atRisk > 0 ? 'warn' : ''}`}>
          <span className="label">Not invoiced — nobody marked</span>
          <span className="figure">{money(atRisk)}</span>
          <span className="note">{unmarkedCount} appointments with no outcome</span>
        </div>
        <div className={`tile ${stopped.length ? 'alert' : ''}`}>
          <span className="label">Front desks gone quiet</span>
          <span className="figure">{stopped.length}</span>
          <span className="note">
            {STOPPED_PCT}%+ of appointments unmarked, {STOPPED_DAYS}+ days old
          </span>
        </div>
        <div className={`tile ${disputes.length ? 'warn' : ''}`}>
          <span className="label">Open disputes</span>
          <span className="figure">{disputes.length}</span>
          <span className="note">awaiting a decision</span>
        </div>
      </section>

      <section>
        <h2>Appointments nobody marked</h2>
        <p className="sub">
          Each of these is either revenue never invoiced, or a front desk that has
          stopped recording attendance. Both need chasing, for different reasons —
          and neither raises an error on its own. <strong>Share</strong> is what
          separates them: a few stragglers are normal, a double-digit share is a
          desk that stopped.
        </p>
        {unmarked.length === 0 ? (
          <p className="empty">Nothing outstanding. Every past appointment has an outcome.</p>
        ) : (
          <div className="scroller"><table>
            <thead>
              <tr>
                <th>Clinic</th>
                <th className="n">Unmarked</th>
                <th className="n">Not invoiced</th>
                <th className="n">Share</th>
                <th className="n">Avg age</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {unmarked.map(r => {
                const stoppedRow = hasStopped(r);
                return (
                  <tr key={r.clinic_id} className={stoppedRow ? 'row-alert' : ''}>
                    <td>{r.business_name}</td>
                    <td className="n">{r.unmarked}</td>
                    <td className="n strong">{money(r.revenue_at_risk_usd)}</td>
                    <td className="n">{Number(r.unmarked_pct).toFixed(1)}%</td>
                    <td className="n dim">{Number(r.avg_days_stale).toFixed(0)}d</td>
                    <td className="flag">
                      {stoppedRow ? 'front desk has stopped recording' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <section>
        <h2>Ready to invoice</h2>
        <p className="sub">
          Attended, billable under the contract, not yet on an invoice.
        </p>
        <div className="scroller"><table>
          <thead>
            <tr>
              <th>Clinic</th>
              <th className="n">Shows</th>
              <th className="n">Value</th>
              <th className="n">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {unbilled.map(r => (
              <tr key={r.clinic_id}>
                <td>{r.business_name}</td>
                <td className="n">{r.shows}</td>
                <td className="n strong">{money(r.value_usd)}</td>
                <td className="n dim">
                  {new Date(r.oldest).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section>
        <h2>Show rate</h2>
        <p className="sub">
          Attended over resolved. Cancellations are excluded — a patient who
          cancelled in advance did not fail to attend, and merging the two makes
          the number useless for the conversation it exists to support.
        </p>
        <div className="scroller"><table>
          <thead>
            <tr>
              <th>Clinic</th>
              <th className="n">Attended</th>
              <th className="n">No-show</th>
              <th className="n">Unmarked</th>
              <th className="n">Show rate</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rates.map(r => {
              const pct = r.show_rate_pct === null ? null : Number(r.show_rate_pct);
              const poor = pct !== null && pct < 55;
              return (
                <tr key={r.clinic_id} className={poor ? 'row-warn' : ''}>
                  <td>{r.business_name}</td>
                  <td className="n">{r.attended}</td>
                  <td className="n">{r.no_shows}</td>
                  <td className="n">{r.unmarked || '—'}</td>
                  <td className="n strong">{pct === null ? '—' : `${pct.toFixed(1)}%`}</td>
                  <td className="flag">{poor ? 'check the confirmation step, not the ads' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>

      {disputes.length > 0 && (
        <section>
          <h2>Open disputes</h2>
          <p className="sub">
            Watch the upheld rate, not the count. A rising upheld percentage means
            the attendance data is wrong, and that is a bigger problem than the credits.
          </p>
          <div className="scroller"><table>
            <thead>
              <tr>
                <th>Clinic</th>
                <th>Raised</th>
                <th>Reason</th>
                <th>Appointment</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map(d => (
                <tr key={d.dispute_id}>
                  <td>{d.business_name}</td>
                  <td className="dim">
                    {new Date(d.raised_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </td>
                  <td>{d.reason}</td>
                  <td className="mono dim">{d.appointment_id}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      <footer>
        Read-only. Billing state changes belong to the n8n workflows, where they
        are logged and idempotent. Nothing is auto-marked and nothing is auto-sent.
      </footer>
    </main>
  );
}
