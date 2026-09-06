-- Demo seed.
--
-- Ninety days of billing history across six chiropractic clinics, so the views
-- return real numbers instead of empty sets and the n8n workflows have
-- something to find on their first run.
--
-- Faults are planted deliberately:
--
--   riverside     ~16 appointments nobody marked, averaging ~10 days old and
--                 concentrated in one recent stretch. That shape is the tell:
--                 a front desk stopped recording attendance on a particular
--                 day. It is the largest source of lost revenue in a
--                 pay-per-show agency and it never raises an error.
--
--   summit        show rate in the 40s against 69-81% elsewhere -- the clinic
--                 that books fine and converts badly
--
--   oakwood       three disputes from one week, two upheld
--
-- Deterministic: pseudo-randomness is hashed off stable keys, so two runs
-- produce identical data and a number quoted on Monday is still true on Friday.
--
-- Idempotent: deletes only rows it owns (`demo_` prefixed ids) and rebuilds.
--
--   psql "$DATABASE_URL" -f db/schema.sql
--   psql "$DATABASE_URL" -f db/seed.sql

BEGIN;

CREATE OR REPLACE FUNCTION pps_draw(key text, salt text DEFAULT '')
RETURNS int LANGUAGE sql IMMUTABLE AS
'SELECT abs((''x'' || substr(md5($1 || ''|'' || $2), 1, 8))::bit(32)::int) % 100';

DELETE FROM disputes        WHERE appointment_id LIKE 'demo_%';
DELETE FROM billable_events WHERE appointment_id LIKE 'demo_%';
DELETE FROM invoices        WHERE invoice_id     LIKE 'demo_%';
DELETE FROM clinics         WHERE clinic_id      LIKE 'demo_%';

-- ---------------------------------------------------------------------------
-- Six clinics. Rates differ because contracts differ -- which is exactly why
-- the rate is frozen onto each event rather than read at invoice time.
-- ---------------------------------------------------------------------------
INSERT INTO clinics (clinic_id, business_name, timezone, status,
                     rate_per_show_cents, billing_period, minimum_cents,
                     bills_returning, contract_start)
VALUES
 ('demo_riverside',  'Riverside Chiropractic',   'America/New_York', 'active',  9500, 'monthly',  50000, false, current_date - 240),
 ('demo_summit',     'Summit Spine & Wellness',  'America/Chicago',  'active', 12000, 'monthly',  60000, false, current_date - 180),
 ('demo_oakwood',    'Oakwood Family Chiro',     'America/New_York', 'active', 11000, 'monthly',      0, true,  current_date - 300),
 ('demo_lakeshore',  'Lakeshore Spine Center',   'America/Chicago',  'active',  8500, 'monthly',  40000, false, current_date - 150),
 ('demo_pinecrest',  'Pinecrest Chiropractic',   'America/Denver',   'active', 10500, 'monthly',      0, false, current_date - 120),
 ('demo_harbor',     'Harbor Point Wellness',    'America/Los_Angeles','active',13500, 'monthly',  75000, true,  current_date -  90);

-- ---------------------------------------------------------------------------
-- Appointments. One row per booking over the last 90 days.
--
-- Volume scales loosely with rate, on the reasoning that a clinic paying more
-- per show is buying a bigger programme.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE pps_appts ON COMMIT DROP AS
WITH days AS (SELECT generate_series(1, 90) AS d),
slots AS (
    SELECT c.clinic_id,
           c.rate_per_show_cents,
           c.bills_returning,
           d.d,
           -- 1-4 bookings a day, weekdays busier than weekends
           GREATEST(0,
             CASE WHEN extract(dow FROM current_date - d.d) IN (0, 6)
                  THEN pps_draw(c.clinic_id, 'we' || d.d) % 2
                  ELSE 1 + pps_draw(c.clinic_id, 'wd' || d.d) % 4
             END) AS n
    FROM clinics c CROSS JOIN days d
    WHERE c.clinic_id LIKE 'demo_%'
)
SELECT s.clinic_id,
       s.rate_per_show_cents,
       s.bills_returning,
       s.d,
       g AS seq,
       'demo_' || replace(s.clinic_id, 'demo_', '') || '_' || s.d || '_' || g AS appointment_id,
       (current_date - s.d)::timestamptz
         + make_interval(hours => 9 + pps_draw(s.clinic_id, 'h' || s.d || g) % 9,
                         mins  => 15 * (pps_draw(s.clinic_id, 'm' || s.d || g) % 4)) AS starts_at,
       pps_draw(s.clinic_id, 'out' || s.d || g) AS r_outcome,
       pps_draw(s.clinic_id, 'new' || s.d || g) AS r_new
FROM slots s
CROSS JOIN LATERAL generate_series(1, s.n) AS g
WHERE s.n > 0;

-- ---------------------------------------------------------------------------
-- Outcomes.
--
-- Base distribution: ~64% attended, ~20% no-show, ~9% cancelled, ~7% unmarked.
-- Unmarked older than a month resolves, because in reality somebody chases it.
-- ---------------------------------------------------------------------------
INSERT INTO billable_events
  (appointment_id, clinic_id, contact_id, booked_at, starts_at,
   outcome, outcome_at, outcome_source, is_new_patient, booked_by, state, rate_cents)
SELECT a.appointment_id,
       a.clinic_id,
       'contact_' || substr(md5(a.appointment_id), 1, 10),
       a.starts_at - make_interval(days => 2 + a.r_new % 9),
       a.starts_at,
       o.outcome,
       CASE WHEN o.outcome = 'unmarked' THEN NULL
            ELSE a.starts_at + interval '3 hours' END,
       CASE WHEN o.outcome = 'unmarked' THEN NULL ELSE 'calendar_sync' END,
       (a.r_new >= 32),                                    -- ~68% new patients
       CASE WHEN a.r_new < 12 THEN 'agent' ELSE 'human' END,
       -- anything attended and billable has already had its rate frozen;
       -- the most recent fortnight is still awaiting the nightly promotion
       CASE WHEN o.outcome <> 'attended'                    THEN 'not_billable'
            WHEN NOT (a.bills_returning OR a.r_new >= 32)   THEN 'not_billable'
            WHEN a.d <= 14                                  THEN 'pending'
            WHEN a.d <= 45                                  THEN 'billable'
            ELSE 'invoiced' END,
       CASE WHEN o.outcome = 'attended' AND a.d > 14
            THEN a.rate_per_show_cents END
FROM pps_appts a
CROSS JOIN LATERAL (
  SELECT CASE
    -- planted: riverside's front desk went quiet for a recent stretch. Real
    -- unmarked gaps are concentrated from the day somebody stopped, not
    -- scattered evenly -- that shape is what makes them diagnosable.
    WHEN a.clinic_id = 'demo_riverside' AND a.d BETWEEN 5 AND 16
         AND a.r_outcome < 76                              THEN 'unmarked'
    -- anything older than a month has been chased and resolved by somebody.
    -- Unmarked that survives a month is not realistic; it is a data bug.
    WHEN a.r_outcome >= 93 AND a.d > 28
         THEN CASE WHEN pps_draw(a.appointment_id, 'late') < 62
                   THEN 'attended' ELSE 'no_show' END
    WHEN a.r_outcome >= 93                                 THEN 'unmarked'
    -- planted: summit books fine and converts badly
    WHEN a.clinic_id = 'demo_summit'    AND a.r_outcome < 38 THEN 'attended'
    WHEN a.clinic_id = 'demo_summit'    AND a.r_outcome < 80 THEN 'no_show'
    WHEN a.clinic_id = 'demo_summit'                         THEN 'cancelled'
    -- everyone else
    WHEN a.r_outcome < 64                                    THEN 'attended'
    WHEN a.r_outcome < 84                                    THEN 'no_show'
    ELSE 'cancelled'
  END AS outcome
) o
WHERE a.starts_at < now();

-- ---------------------------------------------------------------------------
-- Invoices for the closed periods.
-- ---------------------------------------------------------------------------
INSERT INTO invoices (invoice_id, clinic_id, period_start, period_end,
                      shows_count, subtotal_cents, adjustment_cents,
                      total_cents, status, issued_at, paid_at)
SELECT 'demo_inv_' || replace(b.clinic_id, 'demo_', '') || '_' || to_char(m.month, 'YYYYMM'),
       b.clinic_id,
       m.month::date,
       (m.month + interval '1 month' - interval '1 day')::date,
       count(*),
       sum(b.rate_cents),
       GREATEST(0, max(c.minimum_cents) - sum(b.rate_cents)),
       GREATEST(sum(b.rate_cents), max(c.minimum_cents)),
       CASE WHEN m.month < date_trunc('month', current_date - 45) THEN 'paid' ELSE 'sent' END,
       m.month + interval '1 month' + interval '9 hours',
       CASE WHEN m.month < date_trunc('month', current_date - 45)
            THEN m.month + interval '1 month' + interval '11 days' END
FROM billable_events b
JOIN clinics c USING (clinic_id)
CROSS JOIN LATERAL (SELECT date_trunc('month', b.starts_at) AS month) m
WHERE b.state = 'invoiced'
GROUP BY b.clinic_id, m.month
ON CONFLICT (clinic_id, period_start, period_end) DO NOTHING;

UPDATE billable_events b
   SET invoice_id = i.invoice_id
  FROM invoices i
 WHERE b.state = 'invoiced'
   AND b.clinic_id = i.clinic_id
   AND b.starts_at::date BETWEEN i.period_start AND i.period_end;

-- ---------------------------------------------------------------------------
-- Disputes.
--
-- Oakwood queried three lines from one week. Two were upheld -- which is the
-- signal worth watching: a rising upheld rate means the attendance data is
-- wrong, and that is a bigger problem than the credits.
-- ---------------------------------------------------------------------------
INSERT INTO disputes (appointment_id, invoice_id, raised_by, raised_at, reason,
                      evidence, resolution, resolved_at, resolved_by, note)
SELECT b.appointment_id,
       b.invoice_id,
       'Oakwood Family Chiro',
       b.starts_at + interval '20 days',
       'Practice says this patient did not attend',
       jsonb_build_object('booked_by', b.booked_by,
                          'outcome_source', b.outcome_source,
                          'marked_at', b.outcome_at),
       CASE WHEN row_number() OVER (ORDER BY b.starts_at) <= 2
            THEN 'upheld' ELSE NULL END,
       CASE WHEN row_number() OVER (ORDER BY b.starts_at) <= 2
            THEN b.starts_at + interval '23 days' END,
       CASE WHEN row_number() OVER (ORDER BY b.starts_at) <= 2
            THEN 'ops' END,
       CASE WHEN row_number() OVER (ORDER BY b.starts_at) <= 2
            THEN 'Front desk confirmed the patient cancelled by phone and it was never recorded.'
            END
FROM billable_events b
WHERE b.clinic_id = 'demo_oakwood'
  AND b.outcome = 'attended'
  AND b.state = 'invoiced'
ORDER BY b.starts_at
LIMIT 3;

COMMIT;
