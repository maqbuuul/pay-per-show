# Pay Per Show

**Reconcile attended appointments into billable shows.**
The billing engine for an agency that takes $0 until a patient walks in.

GoHighLevel · n8n · Postgres · Vercel

---

## The problem

If you bill per patient who shows up, somebody has to prove who showed up.

At five clinics that's a spreadsheet. At five hundred it's a full-time job that
nobody has, and it fails in three directions at once:

- **Appointments nobody marked.** Not a no-show — missing data. Under
  pay-per-show that is revenue you never invoiced
- **Disputes you can't answer.** A clinic says "that patient never came." Six
  weeks later, what's the evidence?
- **Rates that moved.** You raised a clinic's rate in March. An invoice
  re-generated in June must still show March's number

None of these throw an error. They just quietly cost money.

## The view that finds money

```sql
SELECT * FROM v_unmarked_appointments;
```

Appointments whose time has passed that nobody ever marked attended or
no-show — with the revenue attached:

```
 clinic_id | business_name        | unmarked | revenue_at_risk_usd | avg_days_stale
-----------+----------------------+----------+---------------------+----------------
 bright    | Bright Chiropractic  |        3 |              285.00 |            5.0
```

Two very different problems produce that row, and both need chasing:

1. The front desk stopped recording attendance → the agency is under-billing
2. Nobody is checking → the data every other number depends on is rotting

**This is the first thing to run against a real account**, because the number it
returns is usually not zero.

## What it does

- Mirrors GHL appointment outcomes nightly into `billable_events`
- Applies the contract: new-patient shows bill, returning ones may not
- **Freezes the rate** onto the event when it becomes billable
- Generates invoice lines per clinic per period
- Tracks disputes with the evidence attached — booking source, confirmation
  reply, call recording
- Alerts on unmarked appointments before they age out of anyone's memory

## Three rules, enforced in the schema

**`unmarked` is a state, not an absence.** An appointment nobody marked is not
a no-show. Collapsing the two makes show rate look worse and revenue look
smaller, and hides the actual problem, which is that somebody stopped filling
in a field.

**The rate is copied onto the event, never re-read at invoice time.** Rates
change. An invoice must be reproducible a year later. Re-deriving it from
today's rate card silently rewrites history — and the first time a clinic
notices, every invoice you've ever sent becomes questionable.

**Cancelled is not no-show.** A patient who cancelled in advance did not fail
to attend. Conflating them makes show rate useless for the conversation it
exists to support.

## Run it

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql        # 90 days of demo history

cd dashboard && npm install && npm run dev
```

Then import the three workflows from `n8n/` and add one Postgres credential
named `Postgres account`.

The seed plants what a real account looks like after a quiet quarter:

| Clinic | What the workflows find |
|---|---|
| **Riverside** | 16 appointments nobody marked, **$1,520 not invoiced**, averaging 10 days old and concentrated in one stretch — a front desk that stopped recording on a particular day |
| **Summit** | 44% show rate against 69–81% everywhere else |
| **Oakwood** | Three disputes from one week, two upheld |

## Verify

```bash
npm install && npm run verify
```

Ten assertions over the billing rules, in an in-process Postgres. No database
required.

```
PASS  returning patients excluded when the contract says so
PASS  future appointments are not counted as unmarked
PASS  show rate counts only resolved outcomes
PASS  a rate change does not rewrite already-billable history
```

These are money rules. They should fail loudly the moment somebody changes a
definition, which is exactly what this test is for.

## Layout

```
db/schema.sql    clinics, billable_events, invoices, disputes, the four views
db/seed.sql      90 days of deterministic demo history, faults planted
db/verify.mjs    ten assertions over the billing rules
n8n/             nightly sync, unmarked alert, invoice generation
dashboard/       Next.js on Vercel -- read-only, one env var
docs/            the reconciliation rules and how disputes are handled
```

Everything here runs. The schema and seed are tested against Postgres, the
workflows import into a stock n8n, and the dashboard typechecks and builds
clean.

## Where this sits

[`frontdesk`](../frontdesk) books the appointment.
[`ghl-provisioner`](../ghl-provisioner) builds the account and the workflows
that get the patient to turn up.

This proves they turned up — which is the only event that produces an invoice.

---

Built by [Abdiwahid Ali](https://github.com/maqbuuul). Nairobi.
