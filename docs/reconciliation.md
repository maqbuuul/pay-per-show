# Reconciliation rules

What bills, how an invoice is built, and what happens when a clinic disagrees.
Each rule below is enforced by a function in `db/schema.sql` and covered by
`db/test.mjs`.

## When a show bills

An appointment bills when all of these hold:

1. Its outcome is `attended`
2. It is a new patient, or the clinic's contract bills returning patients
3. It is not already on an invoice
4. It has no open dispute

`no_show`, `cancelled` and `unmarked` never bill. Unmarked is not treated as a
no-show: it means nobody recorded what happened, and billing it would be a
guess.

## The price of a show

A show bills at the clinic's rate **in force on the appointment's own date**,
taken in the clinic's timezone. Rates live in `clinic_rates` with the date each
takes effect.

- The rate is frozen onto the appointment when it becomes billable, so an
  invoice can be regenerated a year later and come out the same.
- A new rate can take effect from tomorrow at the earliest. Nothing that has
  already happened changes price.
- Marking a show attended weeks late still uses the rate from its date, not
  today's.

## Building an invoice

`pps.draft_invoices` drafts each clinic's most recent closed period: the last
calendar month, or the last Monday-to-Sunday week for weekly contracts. Periods
end on the clinic's local date.

1. Every billable show dated up to the end of the period is attached. That
   includes **late additions**: shows from earlier periods that were marked
   attended after those periods were invoiced.
2. Shows total = the sum of their frozen rates.
3. If the clinic has a minimum and the shows total is below it, a top-up brings
   it to the minimum. The minimum does not apply to periods before the contract
   started.
4. Unused credits are applied last, oldest first. Total due never goes below
   zero; whatever is left of a credit carries to the next invoice.

Applying credits after the minimum matters: a clinic under its minimum still
receives the full value of an upheld dispute.

A draft with no shows and no minimum is deleted. Running the draft again
refreshes it rather than creating a second one.

## Changing things after drafting

| Invoice state | What can change |
|---|---|
| Draft | Anything. Re-marking a show recalculates the draft in the same step. |
| Sent | Nothing on the invoice. Corrections go through a dispute and become a credit on a later invoice. |
| Paid | Nothing, and it cannot be voided. Refunds are out of scope. |

Voiding a draft or sent invoice needs a reason. Its shows go back to billable
and its credits are released. An invoice with a line already credited through a
dispute cannot be voided, because the show would then bill again on top of the
credit.

Invoice numbers (`PPS-2026-0042`) are assigned when an invoice is sent, so
discarded drafts do not leave gaps.

## Disputes

A dispute can be raised against an attended show that bills. Raising one:

- takes a snapshot of the evidence as it stands: who booked it, when and how the
  outcome was recorded and by whom, the rate, the invoice number
- takes the show off a draft invoice while the dispute is open
- allows only one open dispute per show

| Resolution | On a sent or paid invoice | Not yet invoiced |
|---|---|---|
| Upheld: the patient did not attend | Outcome becomes no-show, and the rate becomes a credit on the next invoice | Outcome becomes no-show; the show never bills |
| Goodwill: the evidence is unclear | The rate becomes a credit; the outcome stays attended | The show is written off and never bills; no credit |
| Rejected: the evidence holds | Nothing changes | The show returns to the next draft |

Watch the upheld rate rather than the dispute count. A rising upheld share
means attendance is being recorded wrongly, and every other figure depends on
that record.

## Calendar sync

The nightly sync calls `pps.sync_appointments`, which applies the same rules as
marking by hand, with two exceptions:

- An outcome set by an operator or by a dispute is never overwritten by the
  calendar.
- A calendar that has lost a status never turns an existing outcome back into
  unmarked.

## Unmarked appointments

The largest source of lost revenue is not disputes but appointments nobody
marked. `pps.v_unmarked` reports them per clinic with `unmarked_pct`, the share
of that clinic's own appointments over the last 90 days. A high share, with an
average age over a week, points to a front desk that has stopped recording
outcomes. A raw count would only rank clinics by size.

Chase them while people still remember the appointment. Because of the
late-addition rule, marking one attended weeks later still gets it billed.
