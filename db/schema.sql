-- Pay-per-show billing schema.
--
-- Invariants the rest of the system assumes:
--   * billable_events is append-only in spirit; a show moves through states,
--     it is never deleted.
--   * rate_cents is copied onto the event when it becomes billable, never
--     re-read from clinics at invoice time, so old invoices stay reproducible.
--   * 'unmarked' is a state, not an absence. It is not a no-show.

CREATE TABLE IF NOT EXISTS clinics (
    clinic_id        text PRIMARY KEY,           -- GHL sub-account
    business_name    text NOT NULL,
    timezone         text NOT NULL DEFAULT 'America/New_York',
    status           text NOT NULL DEFAULT 'active',

    -- commercials. `rate_per_show_cents` is the whole business model.
    rate_per_show_cents integer NOT NULL,
    billing_period      text NOT NULL DEFAULT 'monthly',  -- monthly | weekly
    minimum_cents       integer NOT NULL DEFAULT 0,
    currency            text NOT NULL DEFAULT 'USD',

    -- new-patient shows bill; a returning patient's follow-up usually does not
    bills_returning     boolean NOT NULL DEFAULT false,

    contract_start   date,
    contract_end     date,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per appointment that could ever be billable.
--
-- Created when the appointment is booked, not when it is attended, so that
-- appointments which never got an outcome are visible rather than absent.
CREATE TABLE IF NOT EXISTS billable_events (
    appointment_id   text PRIMARY KEY,           -- GHL appointment
    clinic_id        text NOT NULL REFERENCES clinics(clinic_id),
    contact_id       text,
    booked_at        timestamptz NOT NULL,
    starts_at        timestamptz NOT NULL,

    -- attended | no_show | cancelled | unmarked
    outcome          text NOT NULL DEFAULT 'unmarked',
    outcome_at       timestamptz,
    outcome_source   text,                       -- ghl_sync | manual | dispute

    is_new_patient   boolean NOT NULL DEFAULT true,
    booked_by        text,                       -- agent | human

    -- billing | rate frozen at the moment it became billable
    state            text NOT NULL DEFAULT 'pending',
      -- pending | billable | invoiced | disputed | written_off | not_billable
    rate_cents       integer,
    invoice_id       text,

    synced_at        timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS be_clinic_idx   ON billable_events (clinic_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS be_state_idx    ON billable_events (state, starts_at DESC);
CREATE INDEX IF NOT EXISTS be_unmarked_idx ON billable_events (starts_at)
    WHERE outcome = 'unmarked';

CREATE TABLE IF NOT EXISTS invoices (
    invoice_id     text PRIMARY KEY,
    clinic_id      text NOT NULL REFERENCES clinics(clinic_id),
    period_start   date NOT NULL,
    period_end     date NOT NULL,
    shows_count    integer NOT NULL DEFAULT 0,
    subtotal_cents integer NOT NULL DEFAULT 0,
    adjustment_cents integer NOT NULL DEFAULT 0,   -- credits from upheld disputes
    total_cents    integer NOT NULL DEFAULT 0,
    status         text NOT NULL DEFAULT 'draft',  -- draft | sent | paid | void
    issued_at      timestamptz,
    paid_at        timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (clinic_id, period_start, period_end)
);

-- Every dispute, and how it resolved. This table is why the agency can hold
-- its position in an argument -- or concede one quickly when it is wrong.
CREATE TABLE IF NOT EXISTS disputes (
    dispute_id     bigserial PRIMARY KEY,
    appointment_id text NOT NULL REFERENCES billable_events(appointment_id),
    invoice_id     text REFERENCES invoices(invoice_id),
    raised_by      text NOT NULL,
    raised_at      timestamptz NOT NULL DEFAULT now(),
    reason         text NOT NULL,
    evidence       jsonb,          -- booking source, confirmation reply, call id
    resolution     text,           -- upheld | rejected | goodwill_credit
    resolved_at    timestamptz,
    resolved_by    text,
    note           text
);

CREATE INDEX IF NOT EXISTS disputes_open_idx ON disputes (raised_at DESC)
    WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- The four screens that matter.
-- ---------------------------------------------------------------------------

-- 1. Attended, billable, not yet on an invoice.
CREATE OR REPLACE VIEW v_unbilled_shows AS
SELECT b.clinic_id,
       c.business_name,
       count(*)                                   AS shows,
       round((sum(coalesce(b.rate_cents, c.rate_per_show_cents)) / 100.0)::numeric, 2) AS value_usd,
       min(b.starts_at)                           AS oldest,
       max(b.starts_at)                           AS newest
FROM billable_events b
JOIN clinics c USING (clinic_id)
WHERE b.outcome = 'attended'
  AND b.state IN ('pending', 'billable')
  AND (c.bills_returning OR b.is_new_patient)
GROUP BY 1, 2;

-- Past appointments with no outcome recorded: unbilled revenue, or a front
-- desk that stopped recording. unmarked_pct separates the two.
CREATE OR REPLACE VIEW v_unmarked_appointments AS
WITH past AS (
    SELECT clinic_id, count(*) AS appointments
    FROM billable_events
    WHERE starts_at < now() - interval '24 hours'
    GROUP BY 1
)
SELECT b.clinic_id,
       c.business_name,
       count(*)                                     AS unmarked,
       round((count(*) * c.rate_per_show_cents / 100.0)::numeric, 2)
                                                    AS revenue_at_risk_usd,
       min(b.starts_at)                             AS oldest,
       round(avg(extract(epoch FROM now() - b.starts_at) / 86400)::numeric, 1)
                                                    AS avg_days_stale,
       -- Share of that clinic's own past appointments. A raw count ranks
       -- clinics by size; a share does not.
       round(100.0 * count(*) / p.appointments, 1)  AS unmarked_pct
FROM billable_events b
JOIN clinics c USING (clinic_id)
JOIN past p     USING (clinic_id)
WHERE b.outcome = 'unmarked'
  AND b.starts_at < now() - interval '24 hours'
GROUP BY 1, 2, c.rate_per_show_cents, p.appointments
ORDER BY 4 DESC;

-- Show rate on the same definition billing uses. Cancelled is excluded: a
-- patient who cancelled in advance did not no-show.
CREATE OR REPLACE VIEW v_clinic_show_rate AS
SELECT clinic_id,
       count(*) FILTER (WHERE outcome IN ('attended','no_show'))  AS resolved,
       count(*) FILTER (WHERE outcome = 'attended')               AS attended,
       count(*) FILTER (WHERE outcome = 'no_show')                AS no_shows,
       count(*) FILTER (WHERE outcome = 'unmarked'
                          AND starts_at < now())                  AS unmarked,
       round(100.0 * count(*) FILTER (WHERE outcome = 'attended')
             / nullif(count(*) FILTER (WHERE outcome IN ('attended','no_show')), 0), 1)
                                                                  AS show_rate_pct
FROM billable_events
WHERE starts_at < now()
GROUP BY 1;

-- Dispute rate. Watch the upheld share, not the count.
CREATE OR REPLACE VIEW v_dispute_summary AS
SELECT b.clinic_id,
       count(*)                                              AS disputes,
       count(*) FILTER (WHERE d.resolution = 'upheld')       AS upheld,
       count(*) FILTER (WHERE d.resolution IS NULL)          AS open,
       round(100.0 * count(*) FILTER (WHERE d.resolution = 'upheld')
             / nullif(count(*) FILTER (WHERE d.resolution IS NOT NULL), 0), 1)
                                                             AS upheld_pct
FROM disputes d
JOIN billable_events b USING (appointment_id)
GROUP BY 1;
