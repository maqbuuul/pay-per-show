# Pay Per Show

**Reconciles attended appointments into billable shows — the billing engine for
an agency that takes $0 until a patient walks in.**

[![Postgres](https://img.shields.io/badge/Neon_Postgres-16-336791?logo=postgresql&logoColor=white)](https://neon.tech)
[![n8n](https://img.shields.io/badge/n8n-3_workflows-EA4B71?logo=n8n&logoColor=white)](https://n8n.io)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Vercel](https://img.shields.io/badge/Vercel-dashboard-000000?logo=vercel&logoColor=white)](https://vercel.com)
[![Tests](https://img.shields.io/badge/tests-10_passing-1c6b58)](db/verify.mjs)
[![License](https://img.shields.io/badge/license-MIT-1c6b58)](LICENSE)

---

## The problem

If you bill per patient who shows up, somebody has to prove who showed up.

At five clinics that's a spreadsheet. At five hundred it's a full-time job
nobody has, and it fails in three directions at once — none of which throws an
error:

- **Appointments nobody marked.** Not a no-show. Missing data. Under
  pay-per-show that is revenue never invoiced
- **Disputes you can't answer.** A clinic says "that patient never came." Six
  weeks later, what's the evidence?
- **Rates that moved.** You raised a clinic's rate in March. An invoice
  regenerated in June must still show March's number

## Architecture

```mermaid
flowchart LR
    SRC["Clinic calendar<br/>GoHighLevel · Cal.com"]:::ext

    subgraph n8n["n8n · scheduled"]
        SYNC["01 nightly outcome sync<br/>full refresh, 45d window"]
        ALERT["02 unmarked alert<br/>weekday 09:00"]
        INV["03 invoice generation<br/>1st of month"]
    end

    subgraph db["Neon · Postgres"]
        BE[("billable_events")]
        INVT[("invoices")]
        DISP[("disputes")]
        V["v_unmarked_appointments<br/>v_unbilled_shows<br/>v_clinic_show_rate"]
    end

    DASH["Dashboard<br/>Vercel · read-only"]
    SLACK["Slack"]:::ext

    SRC --> SYNC
    SYNC -- "idempotent upsert" --> BE
    SYNC -- "freeze rate<br/>when it becomes billable" --> BE
    BE --> V
    DISP --> V
    ALERT --> V
    ALERT -- "revenue nobody invoiced" --> SLACK
    INV --> BE
    INV -- "draft, never sent" --> INVT
    V --> DASH

    classDef ext fill:#f2efe9,stroke:#cfc8ba,color:#46574f
    classDef default fill:#ffffff,stroke:#0d3b34,color:#14201d
    style n8n fill:#eef4f2,stroke:#bcd5cf
    style db fill:#f4f1ec,stroke:#dfd8cc
```

## The view that finds money

```sql
SELECT * FROM v_unmarked_appointments;
```

```
 clinic_id | business_name        | unmarked | revenue_at_risk_usd | avg_days_stale
-----------+----------------------+----------+---------------------+----------------
 riverside | Riverside Chiro      |       16 |             1520.00 |            9.9
 summit    | Summit Spine         |        5 |              600.00 |           13.7
```

Two very different problems produce that top row, and both need chasing:

1. The front desk stopped recording attendance → the agency is under-billing
2. Nobody is checking → the data every other number depends on is rotting

**Run this first against any real account.** The number it returns is usually
not zero.

## Three rules, enforced in the schema

**`unmarked` is a state, not an absence.** An appointment nobody marked is not a
no-show. Collapsing the two makes show rate look worse and revenue look smaller,
and hides the actual problem — that somebody stopped filling in a field.

**The rate is copied onto the event, never re-read at invoice time.** Rates
change. An invoice must be reproducible a year later; re-deriving it from
today's rate card silently rewrites history, and the first time a clinic notices,
every invoice you have ever sent becomes questionable.

**Cancelled is not no-show.** A patient who cancelled in advance did not fail to
attend. Conflating them makes show rate useless for the conversation it exists
to support.

## Nothing is automatic

**The unmarked alert never auto-marks.** Guessing an outcome to clear an alert is
how a billing system starts inventing revenue.

**Invoices are generated as drafts, never sent.** An invoice is a claim on
somebody's money. The system prepares it; a person sends it.

**The nightly sync never walks an invoiced line backwards.** A re-sync cannot
rewrite an invoice you have already issued.

## Run it

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql        # 90 days of demo history

cd dashboard && npm install && npm run dev
```

Import the three workflows from `n8n/` and add one Postgres credential named
exactly `Postgres account`.

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
definition, which is what this test is for.

## Layout

| Path | |
|---|---|
| `db/schema.sql` | 4 tables, 4 views |
| `db/seed.sql` | 90 days across 6 clinics, deterministic, faults planted |
| `db/verify.mjs` | The ten assertions |
| `n8n/` | Nightly sync, unmarked alert, invoice generation |
| `dashboard/` | Read-only Next.js on Vercel, one env var |
| `docs/reconciliation.md` | What bills, what doesn't, how disputes resolve |

## Where this sits

[`frontdesk`](https://github.com/maqbuuul/frontdesk) books the appointment.
[`ghl-provisioner`](https://github.com/maqbuuul/ghl-provisioner) builds the
account and the workflows that get the patient to turn up.

This proves they turned up — the only event that produces an invoice.

---

Built by [Abdiwahid Ali](https://github.com/maqbuuul). Nairobi.
