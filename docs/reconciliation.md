# Reconciliation rules

What counts as a billable show, and what happens when someone disagrees.

## What bills

An appointment bills when **all** of these hold:

1. `outcome = 'attended'`
2. It is a new patient, **or** the contract bills returning patients
3. It is not already on an invoice
4. It is not under an open dispute

Anything else does not bill. In particular:

| Not billable | Why |
|---|---|
| `no_show` | The patient didn't walk in. That's the whole model |
| `cancelled` | Cancelled in advance is not a failed appointment |
| `unmarked` | Nobody recorded an outcome. Billing this would be guessing |

## Disputes

A clinic says a patient never came. The evidence is assembled, not argued:

- Who booked it, and through which channel
- Whether the patient replied to the confirmation
- The call recording, if `frontdesk` took the booking
- When and by whom the appointment was marked attended

Three outcomes:

**Upheld** — the clinic is right. Credit the line, and look at why it was marked
attended. One upheld dispute is noise. A pattern is a broken process.

**Rejected** — the evidence holds. Show it to them. This is the entire reason
the evidence is attached to the row.

**Goodwill credit** — the evidence is ambiguous. Credit it and move on. Arguing
over one appointment costs more than the appointment.

**Watch the upheld rate, not the dispute count.** A rising upheld percentage
means the attendance data is wrong, and that is a far bigger problem than the
credits — because every other number in the business is derived from it.

## The unmarked problem

The largest source of lost revenue in a pay-per-show agency is not disputes. It
is appointments nobody marked.

The system is only as good as the person at the front desk who marks the
appointment attended. If nobody does that:

- The agency under-bills
- Show rate looks worse than it is
- Ad platforms optimising on attendance get bad signal
- Nobody notices, because the number is *lower*, and low numbers don't page

Chase it daily while people still remember the appointment. After a fortnight
nobody can honestly say whether that patient walked in, and the revenue is gone.
