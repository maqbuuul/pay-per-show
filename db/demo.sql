-- Synthetic demo data. Only clinics whose id starts with "demo_" are touched.
--
-- The history is built through the billing functions rather than inserted as
-- finished rows, so the demo obeys the same rules as real data:
--
--   three months ago   invoiced, sent and paid
--   two months ago     invoiced and sent; Summit and Harbor have not paid
--   last month         closed, not yet drafted
--   this month         in progress
--
-- Planted problems for the app to surface:
--   Riverside  a run of unmarked appointments from 5 to 16 days ago
--   Pinecrest  a few appointments from two months ago never marked, so marking
--              them now adds them to the next invoice as late additions
--   Summit     show rate in the 40s against 70-80% elsewhere
--   Oakwood    three disputes on an old invoice: two upheld (credits), one open
--   Riverside  rate rose at the start of last month

CREATE OR REPLACE FUNCTION pps.demo_draw(p_key text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
    SELECT ('x' || substr(md5(p_key), 1, 7))::bit(28)::integer % 100
$$;

CREATE OR REPLACE FUNCTION pps.reset_demo(p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_today     date := current_date;
    v_m1        date := (date_trunc('month', current_date::timestamp) - interval '1 month')::date;
    v_m2        date := (date_trunc('month', current_date::timestamp) - interval '2 months')::date;
    v_m3        date := (date_trunc('month', current_date::timestamp) - interval '3 months')::date;
    r           record;
    v_n         integer := 0;
    v_dispute   jsonb;
    v_counts    jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('pps.reset_demo'));

    -- Clear the previous demo.
    DELETE FROM pps.credits      WHERE clinic_id LIKE 'demo\_%';
    DELETE FROM pps.appointments WHERE clinic_id LIKE 'demo\_%';
    DELETE FROM pps.invoices     WHERE clinic_id LIKE 'demo\_%';
    DELETE FROM pps.clinic_rates WHERE clinic_id LIKE 'demo\_%';
    DELETE FROM pps.clinics      WHERE clinic_id LIKE 'demo\_%';
    DELETE FROM pps.activity     WHERE clinic_id LIKE 'demo\_%' OR entity = 'demo';

    -- Continue invoice numbering after any real invoices.
    PERFORM setval('pps.invoice_number_seq',
                   COALESCE((SELECT max((regexp_match(number, '(\d+)$'))[1]::integer)
                               FROM pps.invoices WHERE number IS NOT NULL), 0) + 1,
                   false);

    INSERT INTO pps.clinics (clinic_id, name, timezone, minimum_cents, bills_returning, contract_start)
    VALUES ('demo_riverside', 'Riverside Chiropractic',  'America/New_York',    50000, false, v_today - 400),
           ('demo_summit',    'Summit Spine & Wellness', 'America/Chicago',     60000, false, v_today - 300),
           ('demo_oakwood',   'Oakwood Family Chiro',    'America/New_York',        0, true,  v_today - 500),
           ('demo_lakeshore', 'Lakeshore Spine Center',  'America/Chicago',     40000, false, v_today - 250),
           ('demo_pinecrest', 'Pinecrest Chiropractic',  'America/Denver',          0, false, v_today - 220),
           ('demo_harbor',    'Harbor Point Wellness',   'America/Los_Angeles', 75000, true,  v_today - 200);

    INSERT INTO pps.clinic_rates (clinic_id, effective_from, rate_cents, created_by)
    SELECT c.clinic_id, c.contract_start, v.rate, 'demo operator'
      FROM pps.clinics c
      JOIN (VALUES ('demo_riverside',  9000), ('demo_summit',   12000),
                   ('demo_oakwood',   11000), ('demo_lakeshore', 8500),
                   ('demo_pinecrest', 10500), ('demo_harbor',   13500)) AS v(clinic_id, rate)
        ON v.clinic_id = c.clinic_id;

    INSERT INTO pps.clinic_rates (clinic_id, effective_from, rate_cents, created_by)
    VALUES ('demo_riverside', v_m1, 9500, 'demo operator');

    -- Appointments from three months ago to two weeks ahead, 9am to 5:45pm in
    -- each clinic's timezone. Weekdays get 1-4 bookings, weekends 0-1.
    INSERT INTO pps.appointments
        (appointment_id, clinic_id, patient_ref, booked_at, starts_at, is_new_patient,
         booked_by, outcome, outcome_source, outcome_at, outcome_by)
    SELECT g.appointment_id,
           g.clinic_id,
           'pt_' || substr(md5(g.appointment_id), 1, 8),
           g.starts_at - make_interval(days => 2 + g.r_new % 9),
           g.starts_at,
           g.r_new >= 32,
           CASE WHEN g.r_new < 12 THEN 'agent' ELSE 'staff' END,
           o.outcome,
           CASE WHEN o.outcome = 'unmarked' THEN NULL ELSE 'calendar' END,
           CASE WHEN o.outcome = 'unmarked' THEN NULL ELSE g.starts_at + interval '3 hours' END,
           CASE WHEN o.outcome = 'unmarked' THEN NULL ELSE 'calendar-sync' END
      FROM (
            SELECT c.clinic_id,
                   dd.d,
                   v_today - dd.d AS days_ago,
                   'demo_' || replace(c.clinic_id, 'demo_', '') || '_'
                           || to_char(dd.d, 'YYYYMMDD') || '_' || n.seq AS appointment_id,
                   ((dd.d + make_interval(
                        hours => 9 + pps.demo_draw(c.clinic_id || dd.d || n.seq || 'h') % 9,
                        mins  => 15 * (pps.demo_draw(c.clinic_id || dd.d || n.seq || 'm') % 4)
                     ))::timestamp AT TIME ZONE c.timezone) AS starts_at,
                   pps.demo_draw(c.clinic_id || dd.d || n.seq || 'o') AS r_out,
                   pps.demo_draw(c.clinic_id || dd.d || n.seq || 'n') AS r_new
              FROM pps.clinics c
             CROSS JOIN generate_series(v_m3::timestamp, (v_today + 14)::timestamp, interval '1 day') AS gs(ts)
             CROSS JOIN LATERAL (SELECT gs.ts::date AS d) dd
             CROSS JOIN LATERAL generate_series(1,
                   CASE WHEN extract(isodow FROM dd.d) IN (6, 7)
                        THEN pps.demo_draw(c.clinic_id || dd.d || 'we') % 2
                        ELSE 1 + pps.demo_draw(c.clinic_id || dd.d || 'wd') % 4
                   END) AS n(seq)
             WHERE c.clinic_id LIKE 'demo\_%'
           ) g
     CROSS JOIN LATERAL (
            SELECT CASE
                WHEN g.starts_at > now()
                    THEN CASE WHEN g.r_out >= 92 THEN 'cancelled' ELSE 'unmarked' END
                WHEN g.clinic_id = 'demo_riverside' AND g.days_ago BETWEEN 5 AND 16 AND g.r_out < 76
                    THEN 'unmarked'
                WHEN g.clinic_id = 'demo_pinecrest'
                     AND date_trunc('month', g.d::timestamp)::date = v_m2 AND g.r_out >= 96
                    THEN 'unmarked'
                WHEN g.r_out >= 93 AND g.days_ago > 28
                    THEN CASE WHEN pps.demo_draw(g.appointment_id || 'late') < 62
                              THEN 'attended' ELSE 'no_show' END
                WHEN g.r_out >= 93 THEN 'unmarked'
                WHEN g.clinic_id = 'demo_summit' AND g.r_out < 38 THEN 'attended'
                WHEN g.clinic_id = 'demo_summit' AND g.r_out < 80 THEN 'no_show'
                WHEN g.clinic_id = 'demo_summit' THEN 'cancelled'
                WHEN g.r_out < 64 THEN 'attended'
                WHEN g.r_out < 84 THEN 'no_show'
                ELSE 'cancelled'
            END AS outcome
           ) o;

    UPDATE pps.appointments a
       SET billing = 'billable',
           rate_cents = pps.rate_on(a.clinic_id, pps.local_day(a.starts_at, c.timezone))
      FROM pps.clinics c
     WHERE c.clinic_id = a.clinic_id
       AND a.clinic_id LIKE 'demo\_%'
       AND a.outcome = 'attended'
       AND (a.is_new_patient OR c.bills_returning);

    -- Three months ago: drafted, sent, paid.
    FOR r IN SELECT clinic_id FROM pps.clinics WHERE clinic_id LIKE 'demo\_%' ORDER BY clinic_id LOOP
        PERFORM pps.draft_invoice_for(r.clinic_id, v_m3, v_m2 - 1, 'seed');
    END LOOP;
    FOR r IN SELECT invoice_id FROM pps.invoices
              WHERE clinic_id LIKE 'demo\_%' AND status = 'draft' ORDER BY clinic_id LOOP
        PERFORM pps.send_invoice(r.invoice_id, 'seed');
        PERFORM pps.record_payment(r.invoice_id, 'seed');
    END LOOP;

    -- Oakwood disputes three lines on that invoice. Two are upheld, which
    -- creates credits for the next invoice; one is still open.
    FOR r IN SELECT a.appointment_id
               FROM pps.appointments a
               JOIN pps.invoices i ON i.invoice_id = a.invoice_id
              WHERE a.clinic_id = 'demo_oakwood' AND i.period_start = v_m3
              ORDER BY a.starts_at
              LIMIT 3 LOOP
        v_n := v_n + 1;
        v_dispute := pps.raise_dispute(r.appointment_id, 'Front desk says this patient did not attend',
                                       'Oakwood front desk', 'seed');
        IF v_n <= 2 THEN
            PERFORM pps.resolve_dispute((v_dispute->>'dispute_id')::bigint, 'upheld',
                'Front desk confirmed the patient cancelled by phone and it was never recorded.', 'seed');
        END IF;
    END LOOP;

    -- Two months ago: drafted and sent. Summit and Harbor have not paid.
    FOR r IN SELECT clinic_id FROM pps.clinics WHERE clinic_id LIKE 'demo\_%' ORDER BY clinic_id LOOP
        PERFORM pps.draft_invoice_for(r.clinic_id, v_m2, v_m1 - 1, 'seed');
    END LOOP;
    FOR r IN SELECT invoice_id, clinic_id FROM pps.invoices
              WHERE clinic_id LIKE 'demo\_%' AND status = 'draft' ORDER BY clinic_id LOOP
        PERFORM pps.send_invoice(r.invoice_id, 'seed');
        IF r.clinic_id NOT IN ('demo_summit', 'demo_harbor') THEN
            PERFORM pps.record_payment(r.invoice_id, 'seed');
        END IF;
    END LOOP;

    -- Put the history on realistic dates.
    UPDATE pps.invoices
       SET created_at = period_end + interval '1 day 8 hours',
           sent_at    = period_end + interval '1 day 9 hours',
           paid_at    = CASE WHEN paid_at IS NOT NULL THEN period_end + interval '12 days 14 hours' END
     WHERE clinic_id LIKE 'demo\_%';

    UPDATE pps.disputes d
       SET raised_at   = a.starts_at + interval '20 days',
           resolved_at = CASE WHEN d.resolved_at IS NOT NULL THEN a.starts_at + interval '23 days' END,
           resolved_by = CASE WHEN d.resolved_at IS NOT NULL THEN 'demo operator' END
      FROM pps.appointments a
     WHERE a.appointment_id = d.appointment_id
       AND a.clinic_id LIKE 'demo\_%';

    UPDATE pps.credits cr
       SET created_at = d.resolved_at, created_by = 'demo operator'
      FROM pps.disputes d
     WHERE d.dispute_id = cr.dispute_id
       AND cr.clinic_id LIKE 'demo\_%';

    UPDATE pps.appointments a
       SET outcome_at = d.resolved_at, outcome_by = 'demo operator'
      FROM pps.disputes d
     WHERE d.appointment_id = a.appointment_id
       AND a.outcome_source = 'dispute'
       AND a.clinic_id LIKE 'demo\_%';

    DELETE FROM pps.activity WHERE actor = 'seed';

    SELECT jsonb_build_object(
             'clinics',      (SELECT count(*) FROM pps.clinics      WHERE clinic_id LIKE 'demo\_%'),
             'appointments', (SELECT count(*) FROM pps.appointments WHERE clinic_id LIKE 'demo\_%'),
             'invoices',     (SELECT count(*) FROM pps.invoices     WHERE clinic_id LIKE 'demo\_%'),
             'disputes',     (SELECT count(*) FROM pps.disputes d
                                JOIN pps.appointments a ON a.appointment_id = d.appointment_id
                               WHERE a.clinic_id LIKE 'demo\_%'))
      INTO v_counts;

    PERFORM pps.log(p_actor, 'demo.reset', 'demo', NULL, NULL, v_counts);
    RETURN v_counts;
END $$;
