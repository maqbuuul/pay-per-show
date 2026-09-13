-- Pay Per Show: tables, views and billing functions.
--
-- Every billing state change goes through a function in this file. The app and
-- the n8n workflows call the same functions, so each rule exists once.
-- Money is integer cents. Dates that decide billing (the rate in force, the
-- invoice period) are taken in the clinic's own timezone.

CREATE SCHEMA IF NOT EXISTS pps;

-- --------------------------------------------------------------------------
-- Tables
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pps.clinics (
    clinic_id        text PRIMARY KEY,
    name             text NOT NULL,
    timezone         text NOT NULL,
    status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'paused', 'ended')),
    billing_period   text NOT NULL DEFAULT 'monthly'
                     CHECK (billing_period IN ('monthly', 'weekly')),
    minimum_cents    integer NOT NULL DEFAULT 0 CHECK (minimum_cents >= 0),
    currency         text NOT NULL DEFAULT 'USD',
    bills_returning  boolean NOT NULL DEFAULT false,
    contract_start   date NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Price per attended show, by the date it takes effect.
CREATE TABLE IF NOT EXISTS pps.clinic_rates (
    clinic_id       text NOT NULL REFERENCES pps.clinics ON DELETE CASCADE,
    effective_from  date NOT NULL,
    rate_cents      integer NOT NULL CHECK (rate_cents > 0),
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (clinic_id, effective_from)
);

CREATE SEQUENCE IF NOT EXISTS pps.invoice_number_seq;

CREATE TABLE IF NOT EXISTS pps.invoices (
    invoice_id           text PRIMARY KEY,
    number               text UNIQUE,              -- assigned when sent
    clinic_id            text NOT NULL REFERENCES pps.clinics ON DELETE CASCADE,
    period_start         date NOT NULL,
    period_end           date NOT NULL,
    currency             text NOT NULL,
    status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'sent', 'paid', 'void')),
    shows_count          integer NOT NULL DEFAULT 0,
    shows_cents          integer NOT NULL DEFAULT 0,
    minimum_topup_cents  integer NOT NULL DEFAULT 0,
    credit_cents         integer NOT NULL DEFAULT 0,
    total_cents          integer NOT NULL DEFAULT 0,
    created_at           timestamptz NOT NULL DEFAULT now(),
    sent_at              timestamptz,
    paid_at              timestamptz,
    voided_at            timestamptz,
    void_reason          text,
    CHECK (period_end >= period_start),
    CHECK (status = 'void' OR (status = 'draft') = (number IS NULL))
);

-- One live invoice per clinic and period; a void one can be replaced.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_per_period
    ON pps.invoices (clinic_id, period_start) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS pps.appointments (
    appointment_id   text PRIMARY KEY,
    clinic_id        text NOT NULL REFERENCES pps.clinics ON DELETE CASCADE,
    patient_ref      text,
    booked_at        timestamptz NOT NULL,
    starts_at        timestamptz NOT NULL,
    is_new_patient   boolean NOT NULL DEFAULT true,
    booked_by        text CHECK (booked_by IN ('agent', 'staff')),
    outcome          text NOT NULL DEFAULT 'unmarked'
                     CHECK (outcome IN ('unmarked', 'attended', 'no_show', 'cancelled')),
    outcome_source   text CHECK (outcome_source IN ('calendar', 'manual', 'dispute')),
    outcome_at       timestamptz,
    outcome_by       text,
    billing          text NOT NULL DEFAULT 'not_billable'
                     CHECK (billing IN ('not_billable', 'billable', 'invoiced', 'written_off')),
    rate_cents       integer,
    invoice_id       text REFERENCES pps.invoices,
    CHECK ((billing = 'not_billable') = (rate_cents IS NULL)),
    CHECK ((billing = 'invoiced') = (invoice_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS appointments_clinic_idx   ON pps.appointments (clinic_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS appointments_invoice_idx  ON pps.appointments (invoice_id);
CREATE INDEX IF NOT EXISTS appointments_unmarked_idx ON pps.appointments (starts_at) WHERE outcome = 'unmarked';
CREATE INDEX IF NOT EXISTS appointments_billable_idx ON pps.appointments (clinic_id) WHERE billing = 'billable';

CREATE TABLE IF NOT EXISTS pps.disputes (
    dispute_id      bigserial PRIMARY KEY,
    appointment_id  text NOT NULL REFERENCES pps.appointments ON DELETE CASCADE,
    raised_at       timestamptz NOT NULL DEFAULT now(),
    raised_by       text NOT NULL,
    reason          text NOT NULL,
    evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- snapshot when raised
    resolution      text CHECK (resolution IN ('upheld', 'rejected', 'goodwill')),
    resolved_at     timestamptz,
    resolved_by     text,
    note            text,
    CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_open
    ON pps.disputes (appointment_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS pps.credits (
    credit_id     bigserial PRIMARY KEY,
    clinic_id     text NOT NULL REFERENCES pps.clinics ON DELETE CASCADE,
    dispute_id    bigint UNIQUE REFERENCES pps.disputes ON DELETE CASCADE,
    amount_cents  integer NOT NULL CHECK (amount_cents > 0),
    reason        text NOT NULL,
    created_by    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- A credit can be spread over several invoices.
CREATE TABLE IF NOT EXISTS pps.credit_applications (
    credit_id     bigint NOT NULL REFERENCES pps.credits ON DELETE CASCADE,
    invoice_id    text NOT NULL REFERENCES pps.invoices ON DELETE CASCADE,
    amount_cents  integer NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (credit_id, invoice_id)
);

CREATE TABLE IF NOT EXISTS pps.activity (
    activity_id  bigserial PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    actor        text NOT NULL,
    action       text NOT NULL,
    entity       text NOT NULL,
    entity_id    text,
    clinic_id    text,
    detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS activity_at_idx     ON pps.activity (at DESC);
CREATE INDEX IF NOT EXISTS activity_entity_idx ON pps.activity (entity, entity_id);

CREATE TABLE IF NOT EXISTS pps.users (
    user_id        bigserial PRIMARY KEY,
    email          text NOT NULL UNIQUE CHECK (email = lower(email)),
    name           text NOT NULL,
    password_hash  text NOT NULL,
    is_demo        boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pps.sessions (
    token_hash    text PRIMARY KEY,               -- sha256 of the cookie value
    user_id       bigint NOT NULL REFERENCES pps.users ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pps.login_attempts (
    attempt_id  bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    email       text NOT NULL,
    ip          text NOT NULL,
    ok          boolean NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_ip_idx    ON pps.login_attempts (ip, at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON pps.login_attempts (email, ip, at DESC);

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pps.local_day(p_at timestamptz, p_tz text)
RETURNS date LANGUAGE sql STABLE AS $$
    SELECT (p_at AT TIME ZONE p_tz)::date
$$;

CREATE OR REPLACE FUNCTION pps.rate_on(p_clinic_id text, p_day date)
RETURNS integer LANGUAGE sql STABLE AS $$
    SELECT rate_cents
      FROM pps.clinic_rates
     WHERE clinic_id = p_clinic_id AND effective_from <= p_day
     ORDER BY effective_from DESC
     LIMIT 1
$$;

CREATE OR REPLACE FUNCTION pps.log(
    p_actor text, p_action text, p_entity text, p_entity_id text,
    p_clinic_id text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO pps.activity (actor, action, entity, entity_id, clinic_id, detail)
    VALUES (p_actor, p_action, p_entity, p_entity_id, p_clinic_id, COALESCE(p_detail, '{}'::jsonb))
$$;

-- The most recent billing period that has ended before p_as_of.
-- Weeks run Monday to Sunday.
CREATE OR REPLACE FUNCTION pps.closed_period(
    p_billing_period text, p_as_of date,
    OUT period_start date, OUT period_end date)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF p_billing_period = 'weekly' THEN
        period_end   := date_trunc('week', p_as_of::timestamp)::date - 1;
        period_start := period_end - 6;
    ELSE
        period_end   := (date_trunc('month', p_as_of::timestamp) - interval '1 day')::date;
        period_start := date_trunc('month', period_end::timestamp)::date;
    END IF;
END $$;

-- Remaining value of a credit, counting applications on invoices that are not void.
CREATE OR REPLACE FUNCTION pps.credit_available(p_credit_id bigint)
RETURNS integer LANGUAGE sql STABLE AS $$
    SELECT c.amount_cents - COALESCE((
             SELECT sum(ca.amount_cents)::integer
               FROM pps.credit_applications ca
               JOIN pps.invoices i ON i.invoice_id = ca.invoice_id
              WHERE ca.credit_id = c.credit_id AND i.status <> 'void'), 0)
      FROM pps.credits c
     WHERE c.credit_id = p_credit_id
$$;

-- --------------------------------------------------------------------------
-- Invoices
-- --------------------------------------------------------------------------

-- Recomputes a draft from the shows attached to it. Credits are applied after
-- the contract minimum, so a clinic under its minimum still receives them.
-- A draft with no shows and no minimum is deleted.
CREATE OR REPLACE FUNCTION pps.recalculate_draft(p_invoice_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    inv          pps.invoices;
    c            pps.clinics;
    v_count      integer;
    v_shows      integer;
    v_topup      integer;
    v_gross      integer;
    v_remaining  integer;
    v_credit     integer := 0;
    v_take       integer;
    cr           record;
BEGIN
    SELECT * INTO inv FROM pps.invoices WHERE invoice_id = p_invoice_id FOR UPDATE;
    IF NOT FOUND OR inv.status <> 'draft' THEN
        RETURN;
    END IF;
    SELECT * INTO c FROM pps.clinics WHERE clinic_id = inv.clinic_id;

    SELECT count(*)::integer, COALESCE(sum(rate_cents), 0)::integer
      INTO v_count, v_shows
      FROM pps.appointments
     WHERE invoice_id = p_invoice_id;

    v_topup := CASE WHEN c.contract_start <= inv.period_start
                    THEN GREATEST(0, c.minimum_cents - v_shows) ELSE 0 END;
    v_gross := v_shows + v_topup;

    DELETE FROM pps.credit_applications WHERE invoice_id = p_invoice_id;

    IF v_count = 0 AND v_topup = 0 THEN
        DELETE FROM pps.invoices WHERE invoice_id = p_invoice_id;
        RETURN;
    END IF;

    v_remaining := v_gross;
    FOR cr IN
        SELECT credit_id, pps.credit_available(credit_id) AS available
          FROM pps.credits
         WHERE clinic_id = inv.clinic_id
         ORDER BY created_at, credit_id
    LOOP
        EXIT WHEN v_remaining = 0;
        CONTINUE WHEN cr.available <= 0;
        v_take := LEAST(cr.available, v_remaining);
        INSERT INTO pps.credit_applications (credit_id, invoice_id, amount_cents)
        VALUES (cr.credit_id, p_invoice_id, v_take);
        v_credit    := v_credit + v_take;
        v_remaining := v_remaining - v_take;
    END LOOP;

    UPDATE pps.invoices
       SET shows_count         = v_count,
           shows_cents         = v_shows,
           minimum_topup_cents = v_topup,
           credit_cents        = v_credit,
           total_cents         = v_gross - v_credit
     WHERE invoice_id = p_invoice_id;
END $$;

-- Drafts (or refreshes) one clinic's invoice for a period. Every billable show
-- up to the period end is attached, including late additions from earlier
-- periods. Shows under an open dispute stay off.
CREATE OR REPLACE FUNCTION pps.draft_invoice_for(
    p_clinic_id text, p_start date, p_end date, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    c           pps.clinics;
    inv         pps.invoices;
    v_new       boolean := false;
    v_attached  integer;
BEGIN
    SELECT * INTO c FROM pps.clinics WHERE clinic_id = p_clinic_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown clinic "%"', p_clinic_id;
    END IF;

    SELECT * INTO inv FROM pps.invoices
     WHERE clinic_id = p_clinic_id AND period_start = p_start AND status <> 'void';

    IF FOUND AND inv.status <> 'draft' THEN
        RETURN jsonb_build_object('clinic_id', p_clinic_id, 'invoice_id', inv.invoice_id,
                                  'result', 'already_' || inv.status);
    END IF;

    IF NOT FOUND THEN
        INSERT INTO pps.invoices (invoice_id, clinic_id, period_start, period_end, currency)
        VALUES ('inv_' || substr(md5(p_clinic_id || p_start::text || clock_timestamp()::text
                                     || random()::text), 1, 16),
                p_clinic_id, p_start, p_end, c.currency)
        RETURNING * INTO inv;
        v_new := true;
    END IF;

    UPDATE pps.appointments a
       SET billing = 'invoiced', invoice_id = inv.invoice_id
     WHERE a.clinic_id = p_clinic_id
       AND a.billing = 'billable'
       AND pps.local_day(a.starts_at, c.timezone) <= p_end
       AND NOT EXISTS (SELECT 1 FROM pps.disputes d
                        WHERE d.appointment_id = a.appointment_id AND d.resolved_at IS NULL);
    GET DIAGNOSTICS v_attached = ROW_COUNT;

    PERFORM pps.recalculate_draft(inv.invoice_id);

    IF NOT EXISTS (SELECT 1 FROM pps.invoices WHERE invoice_id = inv.invoice_id) THEN
        RETURN jsonb_build_object('clinic_id', p_clinic_id, 'invoice_id', NULL,
                                  'result', 'nothing_to_bill');
    END IF;

    PERFORM pps.log(p_actor, CASE WHEN v_new THEN 'invoice.drafted' ELSE 'invoice.refreshed' END,
                    'invoice', inv.invoice_id, p_clinic_id,
                    jsonb_build_object('period_start', p_start, 'period_end', p_end,
                                       'shows_added', v_attached));

    RETURN jsonb_build_object('clinic_id', p_clinic_id, 'invoice_id', inv.invoice_id,
                              'result', CASE WHEN v_new THEN 'drafted' ELSE 'refreshed' END);
END $$;

-- Drafts each clinic's most recent closed period, using its own billing period.
-- With p_as_of NULL, "today" is each clinic's own date, so a clinic whose month
-- has not ended locally is not drafted early.
CREATE OR REPLACE FUNCTION pps.draft_invoices(p_as_of date, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    c      record;
    p      record;
    v_out  jsonb := '[]'::jsonb;
BEGIN
    FOR c IN SELECT clinic_id, billing_period, contract_start, timezone
               FROM pps.clinics WHERE status <> 'ended' ORDER BY clinic_id
    LOOP
        SELECT * INTO p FROM pps.closed_period(
            c.billing_period, COALESCE(p_as_of, pps.local_day(now(), c.timezone)));
        IF p.period_end < c.contract_start THEN
            v_out := v_out || jsonb_build_object('clinic_id', c.clinic_id, 'invoice_id', NULL,
                                                 'result', 'before_contract');
        ELSE
            v_out := v_out || pps.draft_invoice_for(c.clinic_id, p.period_start, p.period_end, p_actor);
        END IF;
    END LOOP;
    RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION pps.send_invoice(p_invoice_id text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    inv pps.invoices;
BEGIN
    SELECT * INTO inv FROM pps.invoices WHERE invoice_id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF inv.status IN ('sent', 'paid') THEN
        RETURN jsonb_build_object('invoice_id', inv.invoice_id, 'number', inv.number,
                                  'status', inv.status, 'changed', false);
    END IF;
    IF inv.status = 'void' THEN
        RAISE EXCEPTION 'A void invoice cannot be sent';
    END IF;

    PERFORM pps.recalculate_draft(p_invoice_id);
    SELECT * INTO inv FROM pps.invoices WHERE invoice_id = p_invoice_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This invoice has nothing to bill';
    END IF;

    UPDATE pps.invoices
       SET status  = 'sent',
           sent_at = now(),
           number  = 'PPS-' || to_char(now(), 'YYYY') || '-'
                     || lpad(nextval('pps.invoice_number_seq')::text, 4, '0')
     WHERE invoice_id = p_invoice_id
    RETURNING * INTO inv;

    PERFORM pps.log(p_actor, 'invoice.sent', 'invoice', inv.invoice_id, inv.clinic_id,
                    jsonb_build_object('number', inv.number, 'total_cents', inv.total_cents));
    RETURN jsonb_build_object('invoice_id', inv.invoice_id, 'number', inv.number,
                              'status', inv.status, 'changed', true);
END $$;

CREATE OR REPLACE FUNCTION pps.record_payment(p_invoice_id text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    inv pps.invoices;
BEGIN
    SELECT * INTO inv FROM pps.invoices WHERE invoice_id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF inv.status = 'paid' THEN
        RETURN jsonb_build_object('invoice_id', inv.invoice_id, 'status', 'paid', 'changed', false);
    END IF;
    IF inv.status <> 'sent' THEN
        RAISE EXCEPTION 'Only a sent invoice can be marked paid';
    END IF;

    UPDATE pps.invoices SET status = 'paid', paid_at = now() WHERE invoice_id = p_invoice_id;
    PERFORM pps.log(p_actor, 'invoice.paid', 'invoice', inv.invoice_id, inv.clinic_id,
                    jsonb_build_object('number', inv.number, 'total_cents', inv.total_cents));
    RETURN jsonb_build_object('invoice_id', inv.invoice_id, 'status', 'paid', 'changed', true);
END $$;

-- Releases the shows and credits on a draft or sent invoice. Refused when a
-- line has already been credited through a dispute, since the shows would
-- bill again on top of the credit.
CREATE OR REPLACE FUNCTION pps.void_invoice(p_invoice_id text, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    inv       pps.invoices;
    v_shows   integer;
BEGIN
    SELECT * INTO inv FROM pps.invoices WHERE invoice_id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF inv.status = 'void' THEN
        RETURN jsonb_build_object('invoice_id', inv.invoice_id, 'status', 'void', 'changed', false);
    END IF;
    IF inv.status = 'paid' THEN
        RAISE EXCEPTION 'A paid invoice cannot be voided';
    END IF;
    IF length(trim(COALESCE(p_reason, ''))) < 3 THEN
        RAISE EXCEPTION 'Give a reason for voiding this invoice';
    END IF;
    IF EXISTS (SELECT 1
                 FROM pps.credits cr
                 JOIN pps.disputes d ON d.dispute_id = cr.dispute_id
                 JOIN pps.appointments a ON a.appointment_id = d.appointment_id
                WHERE a.invoice_id = p_invoice_id) THEN
        RAISE EXCEPTION 'Lines on this invoice have been credited through a dispute, so it cannot be voided';
    END IF;

    UPDATE pps.appointments
       SET billing = 'billable', invoice_id = NULL
     WHERE invoice_id = p_invoice_id;
    GET DIAGNOSTICS v_shows = ROW_COUNT;

    DELETE FROM pps.credit_applications WHERE invoice_id = p_invoice_id;

    UPDATE pps.invoices
       SET status = 'void', voided_at = now(), void_reason = trim(p_reason)
     WHERE invoice_id = p_invoice_id;

    PERFORM pps.log(p_actor, 'invoice.voided', 'invoice', inv.invoice_id, inv.clinic_id,
                    jsonb_build_object('number', inv.number, 'reason', trim(p_reason),
                                       'shows_released', v_shows));
    RETURN jsonb_build_object('invoice_id', inv.invoice_id, 'status', 'void', 'changed', true);
END $$;

-- --------------------------------------------------------------------------
-- Appointments
-- --------------------------------------------------------------------------

-- Sets one outcome and recomputes whether the show bills. Returns a result code:
-- changed, unchanged, not_found, locked_invoice, written_off, future, no_rate.
CREATE OR REPLACE FUNCTION pps.apply_outcome(
    p_appointment_id text, p_outcome text, p_source text, p_actor text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    a         pps.appointments;
    c         pps.clinics;
    v_status  text;
    v_bills   boolean;
    v_rate    integer;
BEGIN
    IF p_outcome NOT IN ('unmarked', 'attended', 'no_show', 'cancelled') THEN
        RAISE EXCEPTION 'Unknown outcome "%"', p_outcome;
    END IF;

    SELECT * INTO a FROM pps.appointments WHERE appointment_id = p_appointment_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;
    SELECT * INTO c FROM pps.clinics WHERE clinic_id = a.clinic_id;
    SELECT status INTO v_status FROM pps.invoices WHERE invoice_id = a.invoice_id;

    IF a.outcome = p_outcome THEN RETURN 'unchanged'; END IF;
    IF v_status IN ('sent', 'paid') THEN RETURN 'locked_invoice'; END IF;
    IF a.billing = 'written_off' THEN RETURN 'written_off'; END IF;
    IF p_outcome IN ('attended', 'no_show') AND a.starts_at > now() THEN RETURN 'future'; END IF;

    v_bills := p_outcome = 'attended' AND (a.is_new_patient OR c.bills_returning);
    IF v_bills THEN
        v_rate := pps.rate_on(a.clinic_id, pps.local_day(a.starts_at, c.timezone));
        IF v_rate IS NULL THEN RETURN 'no_rate'; END IF;
    END IF;

    UPDATE pps.appointments
       SET outcome        = p_outcome,
           outcome_source = CASE WHEN p_outcome = 'unmarked' THEN NULL ELSE p_source END,
           outcome_at     = CASE WHEN p_outcome = 'unmarked' THEN NULL ELSE now() END,
           outcome_by     = CASE WHEN p_outcome = 'unmarked' THEN NULL ELSE p_actor END,
           billing        = CASE WHEN NOT v_bills THEN 'not_billable'
                                 WHEN a.invoice_id IS NOT NULL THEN 'invoiced'
                                 ELSE 'billable' END,
           rate_cents     = CASE WHEN v_bills THEN v_rate END,
           invoice_id     = CASE WHEN v_bills THEN a.invoice_id END
     WHERE appointment_id = p_appointment_id;

    IF a.invoice_id IS NOT NULL THEN
        PERFORM pps.recalculate_draft(a.invoice_id);
    END IF;

    PERFORM pps.log(p_actor, 'appointment.outcome', 'appointment', p_appointment_id, a.clinic_id,
                    jsonb_build_object('from', a.outcome, 'to', p_outcome, 'source', p_source));
    RETURN 'changed';
END $$;

-- Operator marking, one or many. Rows are locked in id order to avoid deadlocks.
CREATE OR REPLACE FUNCTION pps.mark_outcome(p_ids text[], p_outcome text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_id   text;
    v_out  jsonb := '[]'::jsonb;
BEGIN
    FOREACH v_id IN ARRAY COALESCE((SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_ids) x), '{}')
    LOOP
        v_out := v_out || jsonb_build_object(
            'appointment_id', v_id,
            'result', pps.apply_outcome(v_id, p_outcome, 'manual', p_actor));
    END LOOP;
    RETURN v_out;
END $$;

-- Calendar sync. Outcomes set by an operator or a dispute are never overwritten,
-- and a calendar that has lost a status never turns an outcome back to unmarked.
CREATE OR REPLACE FUNCTION pps.sync_appointments(p_rows jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    r         jsonb;
    a         pps.appointments;
    v_in      text;
    v_res     text;
    v_key     text;
    v_counts  jsonb := '{"created":0,"updated":0,"unchanged":0,"kept_manual":0,"skipped":0}'::jsonb;
BEGIN
    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
        v_in := COALESCE(r->>'outcome', 'unmarked');
        SELECT * INTO a FROM pps.appointments WHERE appointment_id = r->>'appointment_id' FOR UPDATE;

        IF NOT FOUND THEN
            INSERT INTO pps.appointments
                (appointment_id, clinic_id, patient_ref, booked_at, starts_at, is_new_patient, booked_by)
            VALUES (r->>'appointment_id', r->>'clinic_id', r->>'patient_ref',
                    (r->>'booked_at')::timestamptz, (r->>'starts_at')::timestamptz,
                    COALESCE((r->>'is_new_patient')::boolean, true), r->>'booked_by');
            IF v_in <> 'unmarked' THEN
                PERFORM pps.apply_outcome(r->>'appointment_id', v_in, 'calendar', p_actor);
            END IF;
            v_key := 'created';
        ELSIF a.outcome_source IN ('manual', 'dispute') THEN
            v_key := CASE WHEN a.outcome = v_in THEN 'unchanged' ELSE 'kept_manual' END;
        ELSIF v_in = 'unmarked' THEN
            v_key := 'unchanged';
        ELSE
            v_res := pps.apply_outcome(a.appointment_id, v_in, 'calendar', p_actor);
            v_key := CASE v_res WHEN 'changed' THEN 'updated'
                                WHEN 'unchanged' THEN 'unchanged'
                                ELSE 'skipped' END;
        END IF;

        v_counts := jsonb_set(v_counts, ARRAY[v_key], to_jsonb((v_counts->>v_key)::integer + 1));
    END LOOP;
    RETURN v_counts;
END $$;

-- --------------------------------------------------------------------------
-- Disputes
-- --------------------------------------------------------------------------

-- Snapshots the evidence as it stands, and takes a line off a draft invoice
-- while the dispute is open.
CREATE OR REPLACE FUNCTION pps.raise_dispute(
    p_appointment_id text, p_reason text, p_raised_by text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    a      pps.appointments;
    inv    pps.invoices;
    v_id   bigint;
BEGIN
    SELECT * INTO a FROM pps.appointments WHERE appointment_id = p_appointment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Appointment not found';
    END IF;
    IF a.outcome <> 'attended' OR a.billing NOT IN ('billable', 'invoiced') THEN
        RAISE EXCEPTION 'Only an attended show that bills can be disputed';
    END IF;
    IF EXISTS (SELECT 1 FROM pps.disputes
                WHERE appointment_id = p_appointment_id AND resolved_at IS NULL) THEN
        RAISE EXCEPTION 'This show already has an open dispute';
    END IF;
    IF length(trim(COALESCE(p_reason, ''))) < 3 THEN
        RAISE EXCEPTION 'Enter the reason the clinic gave';
    END IF;
    IF length(trim(COALESCE(p_raised_by, ''))) = 0 THEN
        RAISE EXCEPTION 'Enter who raised the dispute';
    END IF;

    SELECT * INTO inv FROM pps.invoices WHERE invoice_id = a.invoice_id;

    INSERT INTO pps.disputes (appointment_id, raised_by, reason, evidence)
    VALUES (p_appointment_id, trim(p_raised_by), trim(p_reason), jsonb_build_object(
        'booked_by',      a.booked_by,
        'booked_at',      a.booked_at,
        'starts_at',      a.starts_at,
        'outcome_source', a.outcome_source,
        'outcome_at',     a.outcome_at,
        'outcome_by',     a.outcome_by,
        'rate_cents',     a.rate_cents,
        'invoice_number', inv.number))
    RETURNING dispute_id INTO v_id;

    IF inv.status = 'draft' THEN
        UPDATE pps.appointments SET billing = 'billable', invoice_id = NULL
         WHERE appointment_id = p_appointment_id;
        PERFORM pps.recalculate_draft(inv.invoice_id);
    END IF;

    PERFORM pps.log(p_actor, 'dispute.raised', 'dispute', v_id::text, a.clinic_id,
                    jsonb_build_object('appointment_id', p_appointment_id, 'reason', trim(p_reason)));
    RETURN jsonb_build_object('dispute_id', v_id);
END $$;

-- upheld:   the patient did not attend. A line on a sent invoice becomes a
--           credit; a line not yet invoiced stops billing.
-- goodwill: the outcome stands. A sent line becomes a credit; a line not yet
--           invoiced is written off.
-- rejected: nothing changes except the record.
CREATE OR REPLACE FUNCTION pps.resolve_dispute(
    p_dispute_id bigint, p_resolution text, p_note text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    d         pps.disputes;
    a         pps.appointments;
    v_status  text;
    v_credit  bigint;
BEGIN
    IF p_resolution NOT IN ('upheld', 'rejected', 'goodwill') THEN
        RAISE EXCEPTION 'Unknown resolution "%"', p_resolution;
    END IF;

    SELECT * INTO d FROM pps.disputes WHERE dispute_id = p_dispute_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Dispute not found';
    END IF;
    IF d.resolved_at IS NOT NULL THEN
        IF d.resolution = p_resolution THEN
            RETURN jsonb_build_object('dispute_id', d.dispute_id, 'changed', false);
        END IF;
        RAISE EXCEPTION 'This dispute was already resolved as %', d.resolution;
    END IF;

    SELECT * INTO a FROM pps.appointments WHERE appointment_id = d.appointment_id FOR UPDATE;
    SELECT status INTO v_status FROM pps.invoices WHERE invoice_id = a.invoice_id;

    IF p_resolution IN ('upheld', 'goodwill') THEN
        IF v_status IN ('sent', 'paid') THEN
            INSERT INTO pps.credits (clinic_id, dispute_id, amount_cents, reason, created_by)
            VALUES (a.clinic_id, d.dispute_id, a.rate_cents,
                    CASE p_resolution WHEN 'upheld' THEN 'Dispute upheld' ELSE 'Goodwill credit' END,
                    p_actor)
            RETURNING credit_id INTO v_credit;

            IF p_resolution = 'upheld' THEN
                UPDATE pps.appointments
                   SET outcome = 'no_show', outcome_source = 'dispute',
                       outcome_at = now(), outcome_by = p_actor
                 WHERE appointment_id = a.appointment_id;
            END IF;
        ELSIF p_resolution = 'upheld' THEN
            UPDATE pps.appointments
               SET outcome = 'no_show', outcome_source = 'dispute', outcome_at = now(),
                   outcome_by = p_actor, billing = 'not_billable', rate_cents = NULL
             WHERE appointment_id = a.appointment_id;
        ELSE
            UPDATE pps.appointments SET billing = 'written_off'
             WHERE appointment_id = a.appointment_id;
        END IF;
    END IF;

    UPDATE pps.disputes
       SET resolution = p_resolution, resolved_at = now(), resolved_by = p_actor,
           note = NULLIF(trim(COALESCE(p_note, '')), '')
     WHERE dispute_id = p_dispute_id;

    PERFORM pps.log(p_actor, 'dispute.resolved', 'dispute', p_dispute_id::text, a.clinic_id,
                    jsonb_build_object('resolution', p_resolution,
                                       'appointment_id', a.appointment_id,
                                       'credit_cents', CASE WHEN v_credit IS NOT NULL THEN a.rate_cents END));
    RETURN jsonb_build_object('dispute_id', p_dispute_id, 'credit_id', v_credit, 'changed', true);
END $$;

-- --------------------------------------------------------------------------
-- Clinics
-- --------------------------------------------------------------------------

-- A new rate applies from a future date, so no show that has happened, frozen
-- or not, changes price.
CREATE OR REPLACE FUNCTION pps.set_rate(
    p_clinic_id text, p_rate_cents integer, p_effective_from date, p_actor text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    c      pps.clinics;
    v_old  integer;
BEGIN
    SELECT * INTO c FROM pps.clinics WHERE clinic_id = p_clinic_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown clinic "%"', p_clinic_id;
    END IF;
    IF p_rate_cents IS NULL OR p_rate_cents <= 0 THEN
        RAISE EXCEPTION 'The rate must be more than zero';
    END IF;
    IF p_effective_from IS NULL OR p_effective_from <= pps.local_day(now(), c.timezone) THEN
        RAISE EXCEPTION 'A new rate can take effect from tomorrow at the earliest';
    END IF;

    v_old := pps.rate_on(p_clinic_id, p_effective_from);

    INSERT INTO pps.clinic_rates (clinic_id, effective_from, rate_cents, created_by)
    VALUES (p_clinic_id, p_effective_from, p_rate_cents, p_actor)
    ON CONFLICT (clinic_id, effective_from)
    DO UPDATE SET rate_cents = EXCLUDED.rate_cents, created_by = EXCLUDED.created_by, created_at = now();

    PERFORM pps.log(p_actor, 'clinic.rate_set', 'clinic', p_clinic_id, p_clinic_id,
                    jsonb_build_object('from_cents', v_old, 'to_cents', p_rate_cents,
                                       'effective_from', p_effective_from));
    RETURN jsonb_build_object('clinic_id', p_clinic_id, 'from_cents', v_old,
                              'to_cents', p_rate_cents, 'effective_from', p_effective_from);
END $$;

-- --------------------------------------------------------------------------
-- Reporting
-- --------------------------------------------------------------------------

-- Past appointments (older than a day, within 90 days) with no outcome.
-- value_cents is what they would bill if every eligible one attended.
CREATE OR REPLACE VIEW pps.v_unmarked AS
WITH past AS (
    SELECT clinic_id, count(*) AS appointments
      FROM pps.appointments
     WHERE starts_at < now() - interval '24 hours'
       AND starts_at >= now() - interval '90 days'
     GROUP BY clinic_id
)
SELECT c.clinic_id,
       c.name,
       c.currency,
       count(*)::integer                                          AS unmarked,
       COALESCE(sum(CASE WHEN a.is_new_patient OR c.bills_returning
                         THEN pps.rate_on(c.clinic_id, pps.local_day(a.starts_at, c.timezone))
                    END), 0)::bigint                              AS value_cents,
       round(100.0 * count(*) / p.appointments, 1)                AS unmarked_pct,
       round(avg(extract(epoch FROM now() - a.starts_at) / 86400)::numeric, 1) AS avg_days,
       min(a.starts_at)                                           AS oldest
  FROM pps.appointments a
  JOIN pps.clinics c ON c.clinic_id = a.clinic_id
  JOIN past p ON p.clinic_id = a.clinic_id
 WHERE a.outcome = 'unmarked'
   AND a.starts_at < now() - interval '24 hours'
   AND a.starts_at >= now() - interval '90 days'
 GROUP BY c.clinic_id, p.appointments;
