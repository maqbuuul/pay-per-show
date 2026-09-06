#!/usr/bin/env node
//
// Loads the schema into an in-process Postgres and asserts that the billing
// rules actually hold. These are money rules; they should fail loudly the
// moment somebody changes a definition.
//
//   npm install && npm run verify

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
let failures = 0;

const check = (label, actual, ok, expected) => {
  const pass = ok(actual);
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        got ${JSON.stringify(actual)}${pass ? '' : `, expected ${expected}`}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const n = (v) => (v === null || v === undefined ? null : Number(v));

await db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
console.log('\nschema loads: OK\n');

await db.exec(`
  INSERT INTO clinics (clinic_id, business_name, rate_per_show_cents, bills_returning)
  VALUES ('bright','Bright Chiropractic', 9500, false),
         ('valley','Valley Spine',        12000, true)`);

// bright: 10 attended new, 2 attended returning (not billable), 4 no-show,
//         3 in the past nobody marked, 1 future
const rows = [];
for (let i = 0; i < 10; i++) rows.push(`('b_a${i}','bright',now()-interval '10 days',now()-interval '5 days','attended',true,'pending')`);
for (let i = 0; i < 2; i++)  rows.push(`('b_r${i}','bright',now()-interval '10 days',now()-interval '5 days','attended',false,'pending')`);
for (let i = 0; i < 4; i++)  rows.push(`('b_n${i}','bright',now()-interval '10 days',now()-interval '5 days','no_show',true,'pending')`);
for (let i = 0; i < 3; i++)  rows.push(`('b_u${i}','bright',now()-interval '10 days',now()-interval '5 days','unmarked',true,'pending')`);
rows.push(`('b_f0','bright',now(),now()+interval '5 days','unmarked',true,'pending')`);
// valley bills returning patients too
for (let i = 0; i < 6; i++)  rows.push(`('v_a${i}','valley',now()-interval '9 days',now()-interval '4 days','attended',${i % 2 === 0},'pending')`);

await db.exec(`INSERT INTO billable_events
  (appointment_id, clinic_id, booked_at, starts_at, outcome, is_new_patient, state)
  VALUES ${rows.join(',')}`);

console.log('Billable shows\n');

const bright = await one(`SELECT shows, value_usd FROM v_unbilled_shows WHERE clinic_id='bright'`);
check('returning patients excluded when the contract says so', n(bright.shows),
  (v) => v === 10, '10 (not 12)');
check('value uses the clinic rate', n(bright.value_usd),
  (v) => v === 950, '10 x $95.00 = 950');

const valley = await one(`SELECT shows FROM v_unbilled_shows WHERE clinic_id='valley'`);
check('returning patients included when the contract says so', n(valley.shows),
  (v) => v === 6, '6');

console.log('\nThe view that finds money\n');

const unmarked = await one(`SELECT unmarked, revenue_at_risk_usd
                            FROM v_unmarked_appointments WHERE clinic_id='bright'`);
check('past appointments nobody marked are surfaced', n(unmarked.unmarked),
  (v) => v === 3, '3');
check('future appointments are not counted as unmarked', n(unmarked.unmarked),
  (v) => v === 3, '3, excluding the future one');
check('revenue at risk is quantified', n(unmarked.revenue_at_risk_usd),
  (v) => v === 285, '3 x $95.00 = 285');

console.log('\nShow rate\n');

const sr = await one(`SELECT resolved, attended, unmarked, show_rate_pct
                      FROM v_clinic_show_rate WHERE clinic_id='bright'`);
check('show rate counts only resolved outcomes', n(sr.resolved),
  (v) => v === 16, '16 attended+no_show, excluding unmarked');
check('show rate is attended over resolved', n(sr.show_rate_pct),
  (v) => v === 75, '12/16 = 75.0');
check('unmarked reported alongside, never folded in', n(sr.unmarked),
  (v) => v === 3, '3');

console.log('\nRate is frozen at billing time, not re-derived\n');

await db.exec(`UPDATE billable_events SET rate_cents = 9500, state='billable'
               WHERE appointment_id LIKE 'b_a%'`);
await db.exec(`UPDATE clinics SET rate_per_show_cents = 11000 WHERE clinic_id='bright'`);
const frozen = await one(`SELECT value_usd FROM v_unbilled_shows WHERE clinic_id='bright'`);
check('a rate change does not rewrite already-billable history', n(frozen.value_usd),
  (v) => v === 950, '950 at the old rate, not 1100');

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
