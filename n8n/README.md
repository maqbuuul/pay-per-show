# n8n workflows

Three workflows. All scheduled, none interactive.

## `01-nightly-outcome-sync`

**2am.** Pull every clinic's appointments from GHL for the trailing 45 days and
mirror their status into `billable_events`.

Full refresh over the window rather than incremental. Incremental sync of a CRM
whose webhooks occasionally drop leaves the billing data quietly wrong with no
way to identify which rows — and being quietly wrong about an invoice is worse
than being loudly late with one.

Attendance can be corrected days after the fact by a front desk catching up, so
the window has to be wide enough to pick that up.

## `02-unmarked-alert`

**Daily, 9am.** Reads `v_unmarked_appointments` and posts per clinic:

> Bright Chiropractic: 3 appointments from last week still unmarked. $285 not
> invoiced. Oldest is 5 days old.

Escalates when a clinic's unmarked count keeps climbing — that is a front desk
that has stopped recording attendance, and every other number for that client
is degrading with it.

**Never auto-marks anything.** Guessing an outcome to clear an alert is how a
billing system starts inventing revenue.

## `03-invoice-generation`

**Period end.** Group billable events, freeze the rate, produce the invoice,
apply credits from upheld disputes, hold it as a draft for a human.

**Drafts, never auto-send.** An invoice is a claim on someone's money. The
system prepares it; a person sends it.

## Environment

```
DATABASE_URL
GHL_AGENCY_TOKEN
SLACK_WEBHOOK_URL
UNMARKED_ALERT_HOURS      default 24
SYNC_WINDOW_DAYS          default 45
```
