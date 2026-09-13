#!/usr/bin/env node
// Billing rules, run against an in-process Postgres (PGlite).
//
//   npm test

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
await db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
await db.exec(readFileSync(resolve(here, 'demo.sql'), 'utf8'));

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// jsonb reorders keys, so compare with sorted keys.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;
function eq(actual, expected, label = '') {
  const a = JSON.stringify(canon(actual));
  const e = JSON.stringify(canon(expected));
  if (a !== e) throw new Error(`${label}expected ${e}, got ${a}`);
}

const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
const call = async (sql, params = []) => (await one(`SELECT ${sql} AS r`, params)).r;
async function rejects(sql, params, fragment) {
  try {
    await db.query(`SELECT ${sql}`, params);
  } catch (e) {
    if (!e.message.includes(fragment)) throw new Error(`wrong error: ${e.message}`);
    return;
  }
  throw new Error(`expected an error containing "${fragment}"`);
}

// Dates relative to today, so the suite does not go stale.
const { today, m0, m1, m2 } = await one(`
  SELECT current_date::text AS today,
         date_trunc('month', current_date::timestamp)::date::text AS m0,
         (date_trunc('month', current_date::timestamp) - interval '1 month')::date::text AS m1,
         (date_trunc('month', current_date::timestamp) - interval '2 months')::date::text AS m2`);
const day = (base, n) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function clinic(id, { tz = 'America/New_York', minimum = 0, returning = false, period = 'monthly', rate = 10000 } = {}) {
  await db.query(
    `INSERT INTO pps.clinics (clinic_id, name, timezone, minimum_cents, bills_returning, billing_period, contract_start)
     VALUES ($1, $1, $2, $3, $4, $5, current_date - 400)`,
    [id, tz, minimum, returning, period]);
  await db.query(
    `INSERT INTO pps.clinic_rates (clinic_id, effective_from, rate_cents, created_by)
     VALUES ($1, current_date - 400, $2, 'test')`,
    [id, rate]);
}

// localTime is wall-clock time in the clinic's own timezone.
async function appt(id, clinicId, localTime, { isNew = true } = {}) {
  await db.query(
    `INSERT INTO pps.appointments (appointment_id, clinic_id, booked_at, starts_at, is_new_patient)
     SELECT $1::text, clinic_id, now() - interval '90 days', ($3::timestamp AT TIME ZONE timezone), $4::boolean
       FROM pps.clinics WHERE clinic_id = $2::text`,
    [id, clinicId, localTime, isNew]);
}

const mark = (ids, outcome) =>
  call(`pps.mark_outcome(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)), $2, 'test')`,
       [JSON.stringify(ids), outcome]);

// Drafts the clinic's most recent closed period as of a date.
const draft = (clinicId, asOf) =>
  call(`(SELECT pps.draft_invoice_for(c.clinic_id, p.period_start, p.period_end, 'test')
           FROM pps.clinics c, pps.closed_period(c.billing_period, $2::date) p
          WHERE c.clinic_id = $1)`,
       [clinicId, asOf]);

const invoice = (id, cols) => one(`SELECT ${cols} FROM pps.invoices WHERE invoice_id = $1`, [id]);
const appointment = (id, cols) => one(`SELECT ${cols} FROM pps.appointments WHERE appointment_id = $1`, [id]);

// ---------------------------------------------------------------------------
console.log('\nOutcomes and rates\n');

await clinic('rates', { rate: 9000 });
await db.query(`INSERT INTO pps.clinic_rates (clinic_id, effective_from, rate_cents, created_by)
                VALUES ('rates', $1::date, 9500, 'test')`, [m1]);
await appt('r_old', 'rates', `${day(m2, 4)} 10:00`);
await appt('r_new', 'rates', `${day(m1, 4)} 10:00`);
await appt('r_returning', 'rates', `${day(m1, 5)} 10:00`, { isNew: false });
await appt('r_future', 'rates', `${day(today, 3)} 10:00`);

await test('a show bills at the rate in force on its own date', async () => {
  await mark(['r_old', 'r_new'], 'attended');
  eq(await appointment('r_old', 'rate_cents'), { rate_cents: 9000 });
  eq(await appointment('r_new', 'rate_cents'), { rate_cents: 9500 });
});

await test('an appointment that has not happened cannot be marked attended', async () => {
  eq(await mark(['r_future'], 'attended'), [{ appointment_id: 'r_future', result: 'future' }]);
});

await test('a future appointment can be marked cancelled', async () => {
  eq(await mark(['r_future'], 'cancelled'), [{ appointment_id: 'r_future', result: 'changed' }]);
});

await test('a returning patient does not bill when the contract excludes them', async () => {
  await mark(['r_returning'], 'attended');
  eq(await appointment('r_returning', 'billing, rate_cents'), { billing: 'not_billable', rate_cents: null });
});

await test('each change is written to the activity log with its actor', async () => {
  eq(await one(`SELECT count(*)::int AS n FROM pps.activity
                 WHERE entity_id = 'r_old' AND action = 'appointment.outcome' AND actor = 'test'`), { n: 1 });
});

// "Today" is the clinic's date, which can differ from the UTC date.
await test('a new rate cannot take effect today or earlier', async () => {
  await rejects(`pps.set_rate('rates', 9900, pps.local_day(now(), 'America/New_York'), 'test')`, [], 'from tomorrow');
});

await test('a future rate does not reprice shows already marked', async () => {
  await call(`pps.set_rate('rates', 9900, pps.local_day(now(), 'America/New_York') + 1, 'test')`);
  eq(await appointment('r_new', 'rate_cents'), { rate_cents: 9500 });
});

// ---------------------------------------------------------------------------
console.log('\nInvoices\n');

await clinic('tz', { tz: 'America/Los_Angeles', rate: 12000 });
await appt('tz_edge', 'tz', `${day(m0, -1)} 21:00`);

await test('the invoice period is decided in the clinic timezone, not UTC', async () => {
  // 9pm on the last day of last month in Los Angeles is already this month in UTC.
  await mark(['tz_edge'], 'attended');
  const r = await draft('tz', m0);
  eq(await invoice(r.invoice_id, 'period_start::text AS period_start'), { period_start: m1 });
  eq(await appointment('tz_edge', 'invoice_id'), { invoice_id: r.invoice_id });
});

await clinic('flow', { rate: 10000 });
await appt('w_late', 'flow', `${day(m2, 3)} 10:00`);
await appt('w_1', 'flow', `${day(m1, 3)} 10:00`);
await appt('w_2', 'flow', `${day(m1, 4)} 10:00`);
let flowInvoice;

await test('a draft includes billable shows from earlier periods', async () => {
  await mark(['w_late', 'w_1', 'w_2'], 'attended');
  const r = await draft('flow', m0);
  flowInvoice = r.invoice_id;
  eq(await invoice(flowInvoice, 'period_start::text AS period_start, shows_count, shows_cents'),
     { period_start: m1, shows_count: 3, shows_cents: 30000 });
});

await test('drafting again refreshes the same invoice', async () => {
  const r = await draft('flow', m0);
  eq([r.invoice_id, r.result], [flowInvoice, 'refreshed']);
  eq(await one(`SELECT count(*)::int AS n FROM pps.invoices WHERE clinic_id = 'flow'`), { n: 1 });
});

await test('changing a show on a draft recalculates the draft', async () => {
  await mark(['w_2'], 'no_show');
  eq(await invoice(flowInvoice, 'shows_count, total_cents'), { shows_count: 2, total_cents: 20000 });
  eq(await appointment('w_2', 'invoice_id, billing'), { invoice_id: null, billing: 'not_billable' });
});

await test('sending assigns an invoice number once', async () => {
  const a = await call(`pps.send_invoice($1, 'test')`, [flowInvoice]);
  const b = await call(`pps.send_invoice($1, 'test')`, [flowInvoice]);
  if (!/^PPS-\d{4}-\d{4}$/.test(a.number)) throw new Error(`unexpected number ${a.number}`);
  eq([b.number, b.changed], [a.number, false]);
});

await test('a show on a sent invoice cannot be re-marked', async () => {
  eq(await mark(['w_1'], 'no_show'), [{ appointment_id: 'w_1', result: 'locked_invoice' }]);
});

await test('drafting again does not touch a sent invoice', async () => {
  eq((await draft('flow', m0)).result, 'already_sent');
});

await clinic('floor', { minimum: 50000, rate: 12000 });
await appt('f_prev', 'floor', `${day(m2, 10)} 10:00`);
await appt('f_a', 'floor', `${day(m1, 10)} 10:00`);
await appt('f_b', 'floor', `${day(m1, 11)} 10:00`);
let floorFirstInvoice;

await test('a clinic below its minimum is topped up to it', async () => {
  await mark(['f_prev'], 'attended');
  const r = await draft('floor', m1);
  floorFirstInvoice = r.invoice_id;
  eq(await invoice(r.invoice_id, 'shows_cents, minimum_topup_cents, total_cents'),
     { shows_cents: 12000, minimum_topup_cents: 38000, total_cents: 50000 });
  await call(`pps.send_invoice($1, 'test')`, [r.invoice_id]);
});

await test('a credit comes off after the minimum, so the clinic still receives it', async () => {
  const d = await call(`pps.raise_dispute('f_prev', 'Patient did not attend', 'Front desk', 'test')`);
  await call(`pps.resolve_dispute($1::bigint, 'upheld', 'Confirmed by phone', 'test')`, [d.dispute_id]);
  await mark(['f_a', 'f_b'], 'attended');
  const r = await draft('floor', m0);
  eq(await invoice(r.invoice_id, 'shows_cents, minimum_topup_cents, credit_cents, total_cents'),
     { shows_cents: 24000, minimum_topup_cents: 26000, credit_cents: 12000, total_cents: 38000 });
});

await clinic('carry', { rate: 10000 });
await appt('c_1', 'carry', `${day(m2, 5)} 10:00`);
await appt('c_2', 'carry', `${day(m2, 6)} 10:00`);
await appt('c_3', 'carry', `${day(m1, 5)} 10:00`);

await test('credit larger than the next invoice carries forward', async () => {
  await mark(['c_1', 'c_2'], 'attended');
  const first = await draft('carry', m1);
  await call(`pps.send_invoice($1, 'test')`, [first.invoice_id]);
  for (const id of ['c_1', 'c_2']) {
    const d = await call(`pps.raise_dispute($1, 'Did not attend', 'Front desk', 'test')`, [id]);
    await call(`pps.resolve_dispute($1::bigint, 'upheld', NULL, 'test')`, [d.dispute_id]);
  }
  await mark(['c_3'], 'attended');
  const second = await draft('carry', m0);
  eq(await invoice(second.invoice_id, 'credit_cents, total_cents'), { credit_cents: 10000, total_cents: 0 });
  eq(await one(`SELECT sum(pps.credit_available(credit_id))::int AS remaining
                  FROM pps.credits WHERE clinic_id = 'carry'`), { remaining: 10000 });
});

await clinic('empty');
await test('a period with nothing to bill and no minimum creates no invoice', async () => {
  eq((await draft('empty', m0)).result, 'nothing_to_bill');
  eq(await one(`SELECT count(*)::int AS n FROM pps.invoices WHERE clinic_id = 'empty'`), { n: 0 });
});

await test('weekly periods run Monday to Sunday', async () => {
  eq(await one(`SELECT period_start::text AS s, period_end::text AS e
                  FROM pps.closed_period('weekly', '2026-09-16')`), { s: '2026-09-07', e: '2026-09-13' });
});

await test('monthly periods are the previous calendar month', async () => {
  eq(await one(`SELECT period_start::text AS s, period_end::text AS e
                  FROM pps.closed_period('monthly', '2026-09-16')`), { s: '2026-08-01', e: '2026-08-31' });
});

// ---------------------------------------------------------------------------
console.log('\nVoiding\n');

await clinic('voids', { rate: 10000 });
await appt('v_1', 'voids', `${day(m1, 2)} 10:00`);
await appt('v_2', 'voids', `${day(m2, 2)} 10:00`);
let voidInvoice;

await test('voiding needs a reason', async () => {
  await mark(['v_1'], 'attended');
  voidInvoice = (await draft('voids', m0)).invoice_id;
  await call(`pps.send_invoice($1, 'test')`, [voidInvoice]);
  await rejects(`pps.void_invoice($1, '', 'test')`, [voidInvoice], 'Give a reason');
});

await test('voiding a sent invoice releases its shows for a new draft', async () => {
  await call(`pps.void_invoice($1, 'Wrong clinic address', 'test')`, [voidInvoice]);
  eq(await appointment('v_1', 'billing, invoice_id'), { billing: 'billable', invoice_id: null });
  const again = await draft('voids', m0);
  if (again.invoice_id === voidInvoice) throw new Error('expected a new invoice');
  eq(await invoice(again.invoice_id, 'status, shows_count'), { status: 'draft', shows_count: 1 });
});

await test('a paid invoice cannot be voided', async () => {
  await mark(['v_2'], 'attended');
  const r = await draft('voids', m1);
  await call(`pps.send_invoice($1, 'test')`, [r.invoice_id]);
  await call(`pps.record_payment($1, 'test')`, [r.invoice_id]);
  await rejects(`pps.void_invoice($1, 'Mistake', 'test')`, [r.invoice_id], 'paid invoice cannot be voided');
});

await test('an invoice with a line credited through a dispute cannot be voided', async () => {
  await rejects(`pps.void_invoice($1, 'Mistake', 'test')`, [floorFirstInvoice], 'credited through a dispute');
});

// ---------------------------------------------------------------------------
console.log('\nDisputes\n');

await clinic('disp', { rate: 10000 });
await appt('d_1', 'disp', `${day(m1, 7)} 10:00`);
await appt('d_2', 'disp', `${day(m1, 8)} 10:00`);
await appt('d_3', 'disp', `${day(m1, 9)} 10:00`);
let dispInvoice;
let openDispute;

await test('a disputed line comes off a draft while the dispute is open', async () => {
  await mark(['d_1', 'd_2', 'd_3'], 'attended');
  dispInvoice = (await draft('disp', m0)).invoice_id;
  openDispute = (await call(`pps.raise_dispute('d_1', 'Did not attend', 'Front desk', 'test')`)).dispute_id;
  eq(await invoice(dispInvoice, 'shows_count'), { shows_count: 2 });
});

await test('a show can have only one open dispute', async () => {
  await rejects(`pps.raise_dispute('d_1', 'Again', 'Front desk', 'test')`, [], 'already has an open dispute');
});

await test('the dispute keeps a snapshot of the evidence', async () => {
  const { evidence } = await one(`SELECT evidence FROM pps.disputes WHERE dispute_id = $1`, [openDispute]);
  eq([evidence.outcome_source, evidence.outcome_by, evidence.rate_cents], ['manual', 'test', 10000]);
});

await test('a rejected dispute puts the show back on the draft', async () => {
  await call(`pps.resolve_dispute($1::bigint, 'rejected', 'Confirmation reply on file', 'test')`, [openDispute]);
  await draft('disp', m0);
  eq(await invoice(dispInvoice, 'shows_count'), { shows_count: 3 });
});

await test('goodwill on a show not yet invoiced writes it off without a credit', async () => {
  const d = await call(`pps.raise_dispute('d_2', 'Unclear', 'Front desk', 'test')`);
  await call(`pps.resolve_dispute($1::bigint, 'goodwill', NULL, 'test')`, [d.dispute_id]);
  await draft('disp', m0);
  eq(await appointment('d_2', 'billing'), { billing: 'written_off' });
  eq(await invoice(dispInvoice, 'shows_count'), { shows_count: 2 });
  eq(await one(`SELECT count(*)::int AS n FROM pps.credits WHERE clinic_id = 'disp'`), { n: 0 });
});

await test('an upheld dispute on a sent line credits the rate and records the no-show', async () => {
  eq(await one(`SELECT amount_cents FROM pps.credits WHERE clinic_id = 'floor'`), { amount_cents: 12000 });
  eq(await appointment('f_prev', 'outcome, outcome_source'), { outcome: 'no_show', outcome_source: 'dispute' });
});

// ---------------------------------------------------------------------------
console.log('\nCalendar sync\n');

await clinic('sync', { rate: 10000 });
const syncRow = (id, outcome) => ({
  appointment_id: id, clinic_id: 'sync', outcome,
  booked_at: `${day(m1, 1)}T12:00:00Z`, starts_at: `${day(m1, 12)}T15:00:00Z`,
});
const sync = (list) => call(`pps.sync_appointments($1::jsonb, 'calendar-sync')`, [JSON.stringify(list)]);

await test('the sync creates appointments and applies their outcomes', async () => {
  const r = await sync([syncRow('s_1', 'attended'), syncRow('s_2', 'unmarked')]);
  eq(r.created, 2);
  eq(await appointment('s_1', 'billing'), { billing: 'billable' });
});

await test('the sync never overwrites an outcome set by an operator', async () => {
  await mark(['s_1'], 'no_show');
  const r = await sync([syncRow('s_1', 'attended')]);
  eq(r.kept_manual, 1);
  eq(await appointment('s_1', 'outcome'), { outcome: 'no_show' });
});

await test('a calendar that loses a status does not reset an outcome', async () => {
  eq((await sync([syncRow('s_2', 'attended')])).updated, 1);
  eq((await sync([syncRow('s_2', 'unmarked')])).unchanged, 1);
  eq(await appointment('s_2', 'outcome'), { outcome: 'attended' });
});

// ---------------------------------------------------------------------------
console.log('\nDemo data\n');

const realBefore = await one(`SELECT count(*)::int AS n FROM pps.appointments WHERE clinic_id NOT LIKE 'demo\\_%'`);
let firstReset;

await test('reset builds the demo and gives the same result when repeated', async () => {
  firstReset = await call(`pps.reset_demo('test')`);
  const second = await call(`pps.reset_demo('test')`);
  eq(second, firstReset);
  if (firstReset.appointments < 500) throw new Error(`only ${firstReset.appointments} appointments`);
});

await test('reset leaves other clinics alone', async () => {
  eq(await one(`SELECT count(*)::int AS n FROM pps.appointments WHERE clinic_id NOT LIKE 'demo\\_%'`), realBefore);
});

await test('reset leaves a single activity entry', async () => {
  eq(await one(`SELECT count(*)::int AS n FROM pps.activity WHERE clinic_id LIKE 'demo\\_%' OR entity = 'demo'`), { n: 1 });
});

await test('the demo has the problems the app is meant to surface', async () => {
  const top = await one(`SELECT clinic_id, unmarked FROM pps.v_unmarked
                          WHERE clinic_id LIKE 'demo\\_%' ORDER BY unmarked_pct DESC LIMIT 1`);
  if (top.clinic_id !== 'demo_riverside' || top.unmarked < 10) throw new Error(`top unmarked ${JSON.stringify(top)}`);

  eq(await one(`SELECT count(*) FILTER (WHERE d.resolved_at IS NULL)::int AS open,
                       count(*) FILTER (WHERE d.resolution = 'upheld')::int AS upheld
                  FROM pps.disputes d JOIN pps.appointments a USING (appointment_id)
                 WHERE a.clinic_id = 'demo_oakwood'`), { open: 1, upheld: 2 });

  eq(await one(`SELECT count(*) FILTER (WHERE period_start = $1::date)::int AS last_month,
                       count(*) FILTER (WHERE status = 'sent')::int AS unpaid,
                       count(*) FILTER (WHERE status = 'paid')::int AS paid
                  FROM pps.invoices WHERE clinic_id LIKE 'demo\\_%'`, [m1]),
     { last_month: 0, unpaid: 2, paid: 10 });

  const late = await one(`SELECT count(*)::int AS n FROM pps.appointments a JOIN pps.clinics c USING (clinic_id)
                           WHERE a.clinic_id = 'demo_pinecrest' AND a.outcome = 'unmarked'
                             AND date_trunc('month', pps.local_day(a.starts_at, c.timezone)::timestamp)::date = $1::date`, [m2]);
  if (late.n < 1) throw new Error('no unmarked Pinecrest appointments from two months ago');

  eq(await one(`SELECT count(*)::int AS n FROM pps.invoices
                 WHERE clinic_id = 'demo_oakwood' AND period_start = $1::date AND credit_cents = 22000`, [m2]), { n: 1 });
});

console.log(failed ? `\n${failed} failed.\n` : '\nAll checks passed.\n');
process.exit(failed ? 1 : 0);
