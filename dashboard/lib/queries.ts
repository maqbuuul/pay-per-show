import { sql } from './db';
import { NET_DAYS } from './format';

export const PAGE_SIZE = 50;

export type ClinicOption = { clinic_id: string; name: string; timezone: string; currency: string };

export const clinicOptions = () =>
  sql<ClinicOption>`SELECT clinic_id, name, timezone, currency FROM pps.clinics ORDER BY name`;

export async function navCounts() {
  const [r] = await sql<{ unmarked: number; drafts: number; disputes: number }>`
    SELECT (SELECT count(*) FROM pps.appointments
             WHERE outcome = 'unmarked'
               AND starts_at < now() - interval '24 hours'
               AND starts_at >= now() - interval '90 days')::int AS unmarked,
           (SELECT count(*) FROM pps.invoices WHERE status = 'draft')::int AS drafts,
           (SELECT count(*) FROM pps.disputes WHERE resolved_at IS NULL)::int AS disputes`;
  return r;
}

// ---------------------------------------------------------------------------
// Today

export type UnmarkedRow = {
  clinic_id: string; name: string; currency: string; unmarked: number;
  value_cents: number; unmarked_pct: string; avg_days: string; oldest: Date;
};

export const unmarkedByClinic = () => sql<UnmarkedRow>`
  SELECT clinic_id, name, currency, unmarked, value_cents::int AS value_cents,
         unmarked_pct::text AS unmarked_pct, avg_days::text AS avg_days, oldest
    FROM pps.v_unmarked
   ORDER BY value_cents DESC, name`;

export type UndraftedRow = {
  clinic_id: string; name: string; currency: string; period_start: string; period_end: string;
  shows: number; shows_cents: number; minimum_cents: number;
};

/** Each clinic's most recent closed period that has no invoice yet. */
export const undraftedPeriods = () => sql<UndraftedRow>`
  SELECT c.clinic_id, c.name, c.currency, c.minimum_cents,
         p.period_start::text AS period_start, p.period_end::text AS period_end,
         count(a.appointment_id)::int AS shows,
         COALESCE(sum(a.rate_cents), 0)::int AS shows_cents
    FROM pps.clinics c
   CROSS JOIN LATERAL pps.closed_period(c.billing_period, pps.local_day(now(), c.timezone)) p
    LEFT JOIN pps.appointments a
           ON a.clinic_id = c.clinic_id
          AND a.billing = 'billable'
          AND pps.local_day(a.starts_at, c.timezone) <= p.period_end
          AND NOT EXISTS (SELECT 1 FROM pps.disputes d
                           WHERE d.appointment_id = a.appointment_id AND d.resolved_at IS NULL)
   WHERE c.status <> 'ended'
     AND p.period_end >= c.contract_start
     AND NOT EXISTS (SELECT 1 FROM pps.invoices i
                      WHERE i.clinic_id = c.clinic_id
                        AND i.period_start = p.period_start
                        AND i.status <> 'void')
   GROUP BY c.clinic_id, p.period_start, p.period_end
  HAVING count(a.appointment_id) > 0 OR c.minimum_cents > 0
   ORDER BY c.name`;

export type InvoiceTotal = { status: 'draft' | 'sent' | 'overdue'; currency: string; count: number; cents: number };

export const openInvoiceTotals = () => sql<InvoiceTotal>`
  SELECT CASE WHEN status = 'sent' AND sent_at < now() - make_interval(days => ${NET_DAYS})
              THEN 'overdue' ELSE status END AS status,
         currency, count(*)::int AS count, sum(total_cents)::int AS cents
    FROM pps.invoices
   WHERE status IN ('draft', 'sent')
   GROUP BY 1, currency`;

export async function openDisputeSummary() {
  const [r] = await sql<{ count: number; oldest: Date | null }>`
    SELECT count(*)::int AS count, min(raised_at) AS oldest
      FROM pps.disputes WHERE resolved_at IS NULL`;
  return r;
}

export type ClinicHealth = {
  clinic_id: string; name: string; timezone: string; currency: string; billing_period: string;
  minimum_cents: number; bills_returning: boolean; rate_cents: number | null;
  attended: number; no_shows: number; show_rate: string | null; unmarked: number;
  outstanding_cents: number; open_disputes: number;
};

/** Last 30 days per clinic. */
export const clinicHealth = () => sql<ClinicHealth>`
  SELECT c.clinic_id, c.name, c.timezone, c.currency, c.billing_period,
         c.minimum_cents, c.bills_returning,
         pps.rate_on(c.clinic_id, pps.local_day(now(), c.timezone)) AS rate_cents,
         count(a.appointment_id) FILTER (WHERE a.outcome = 'attended')::int AS attended,
         count(a.appointment_id) FILTER (WHERE a.outcome = 'no_show')::int AS no_shows,
         round(100.0 * count(a.appointment_id) FILTER (WHERE a.outcome = 'attended')
               / nullif(count(a.appointment_id) FILTER (WHERE a.outcome IN ('attended', 'no_show')), 0),
               1)::text AS show_rate,
         count(a.appointment_id) FILTER (WHERE a.outcome = 'unmarked'
                                           AND a.starts_at < now() - interval '24 hours')::int AS unmarked,
         (SELECT COALESCE(sum(i.total_cents), 0)::int FROM pps.invoices i
           WHERE i.clinic_id = c.clinic_id AND i.status = 'sent') AS outstanding_cents,
         (SELECT count(*)::int FROM pps.disputes d
            JOIN pps.appointments x ON x.appointment_id = d.appointment_id
           WHERE x.clinic_id = c.clinic_id AND d.resolved_at IS NULL) AS open_disputes
    FROM pps.clinics c
    LEFT JOIN pps.appointments a
           ON a.clinic_id = c.clinic_id
          AND a.starts_at >= now() - interval '30 days'
          AND a.starts_at < now()
   GROUP BY c.clinic_id
   ORDER BY c.name`;

// ---------------------------------------------------------------------------
// Appointments

export const OUTCOMES = ['unmarked', 'attended', 'no_show', 'cancelled'] as const;
export const BILLINGS = ['not_billable', 'billable', 'invoiced', 'written_off'] as const;

export type AppointmentFilters = {
  clinic?: string; outcome?: string; billing?: string;
  from: string; to: string; q?: string; page: number;
};

export type AppointmentRow = {
  appointment_id: string; clinic_id: string; clinic_name: string; timezone: string; currency: string;
  starts_at: Date; patient_ref: string | null; is_new_patient: boolean; booked_by: string | null;
  outcome: string; outcome_source: string | null; billing: string; rate_cents: number | null;
  invoice_id: string | null; invoice_number: string | null; invoice_status: string | null;
  disputed: boolean; total: number;
};

export function listAppointments(f: AppointmentFilters) {
  const clinic = f.clinic ?? null;
  const outcome = f.outcome ?? null;
  const billing = f.billing ?? null;
  const q = f.q ?? null;
  return sql<AppointmentRow>`
    SELECT a.appointment_id, a.clinic_id, c.name AS clinic_name, c.timezone, c.currency,
           a.starts_at, a.patient_ref, a.is_new_patient, a.booked_by,
           a.outcome, a.outcome_source, a.billing, a.rate_cents,
           a.invoice_id, i.number AS invoice_number, i.status AS invoice_status,
           EXISTS (SELECT 1 FROM pps.disputes d
                    WHERE d.appointment_id = a.appointment_id AND d.resolved_at IS NULL) AS disputed,
           count(*) OVER ()::int AS total
      FROM pps.appointments a
      JOIN pps.clinics c ON c.clinic_id = a.clinic_id
      LEFT JOIN pps.invoices i ON i.invoice_id = a.invoice_id
     WHERE (${clinic}::text IS NULL OR a.clinic_id = ${clinic}::text)
       AND (${outcome}::text IS NULL OR a.outcome = ${outcome}::text)
       AND (${billing}::text IS NULL OR a.billing = ${billing}::text)
       AND pps.local_day(a.starts_at, c.timezone) BETWEEN ${f.from}::date AND ${f.to}::date
       AND (${q}::text IS NULL
            OR a.appointment_id ILIKE '%' || ${q}::text || '%'
            OR a.patient_ref ILIKE '%' || ${q}::text || '%')
     ORDER BY a.starts_at DESC, a.appointment_id
     LIMIT ${PAGE_SIZE} OFFSET ${f.page * PAGE_SIZE}`;
}

export type AppointmentDetail = {
  appointment_id: string; clinic_id: string; clinic_name: string; timezone: string; currency: string;
  patient_ref: string | null; booked_at: Date; starts_at: Date; is_new_patient: boolean;
  booked_by: string | null; outcome: string; outcome_source: string | null; outcome_at: Date | null;
  outcome_by: string | null; billing: string; rate_cents: number | null; invoice_id: string | null;
  invoice_number: string | null; invoice_status: string | null;
};

export async function getAppointment(id: string) {
  const [row] = await sql<AppointmentDetail>`
    SELECT a.appointment_id, a.clinic_id, c.name AS clinic_name, c.timezone, c.currency,
           a.patient_ref, a.booked_at, a.starts_at, a.is_new_patient, a.booked_by,
           a.outcome, a.outcome_source, a.outcome_at, a.outcome_by, a.billing, a.rate_cents,
           a.invoice_id, i.number AS invoice_number, i.status AS invoice_status
      FROM pps.appointments a
      JOIN pps.clinics c ON c.clinic_id = a.clinic_id
      LEFT JOIN pps.invoices i ON i.invoice_id = a.invoice_id
     WHERE a.appointment_id = ${id}`;
  return row;
}

// ---------------------------------------------------------------------------
// Invoices

export const INVOICE_STATUSES = ['draft', 'sent', 'overdue', 'paid', 'void'] as const;

export type InvoiceRow = {
  invoice_id: string; number: string | null; clinic_id: string; clinic_name: string;
  period_start: string; period_end: string; currency: string; status: string;
  shows_count: number; total_cents: number; sent_at: Date | null; paid_at: Date | null;
  voided_at: Date | null; created_at: Date; overdue: boolean;
};

export function listInvoices({ status, clinic }: { status?: string; clinic?: string }) {
  const s = status ?? null;
  const c = clinic ?? null;
  return sql<InvoiceRow>`
    SELECT i.invoice_id, i.number, i.clinic_id, cl.name AS clinic_name,
           i.period_start::text AS period_start, i.period_end::text AS period_end,
           i.currency, i.status, i.shows_count, i.total_cents,
           i.sent_at, i.paid_at, i.voided_at, i.created_at,
           (i.status = 'sent' AND i.sent_at < now() - make_interval(days => ${NET_DAYS})) AS overdue
      FROM pps.invoices i
      JOIN pps.clinics cl ON cl.clinic_id = i.clinic_id
     WHERE (${s}::text IS NULL
            OR (${s}::text = 'overdue' AND i.status = 'sent'
                AND i.sent_at < now() - make_interval(days => ${NET_DAYS}))
            OR i.status = ${s}::text)
       AND (${c}::text IS NULL OR i.clinic_id = ${c}::text)
     ORDER BY i.period_start DESC, cl.name
     LIMIT 300`;
}

export async function invoiceCounts() {
  const [r] = await sql<Record<'all' | 'draft' | 'sent' | 'overdue' | 'paid' | 'void', number>>`
    SELECT count(*)::int AS all,
           count(*) FILTER (WHERE status = 'draft')::int AS draft,
           count(*) FILTER (WHERE status = 'sent')::int AS sent,
           count(*) FILTER (WHERE status = 'sent'
                              AND sent_at < now() - make_interval(days => ${NET_DAYS}))::int AS overdue,
           count(*) FILTER (WHERE status = 'paid')::int AS paid,
           count(*) FILTER (WHERE status = 'void')::int AS void
      FROM pps.invoices`;
  return r;
}

export type InvoiceDetail = InvoiceRow & {
  timezone: string; minimum_cents: number; shows_cents: number; minimum_topup_cents: number;
  credit_cents: number; void_reason: string | null;
};

export async function getInvoice(id: string) {
  const [row] = await sql<InvoiceDetail>`
    SELECT i.invoice_id, i.number, i.clinic_id, c.name AS clinic_name, c.timezone, c.minimum_cents,
           i.period_start::text AS period_start, i.period_end::text AS period_end,
           i.currency, i.status, i.shows_count, i.shows_cents, i.minimum_topup_cents,
           i.credit_cents, i.total_cents, i.sent_at, i.paid_at, i.voided_at, i.void_reason,
           i.created_at,
           (i.status = 'sent' AND i.sent_at < now() - make_interval(days => ${NET_DAYS})) AS overdue
      FROM pps.invoices i
      JOIN pps.clinics c ON c.clinic_id = i.clinic_id
     WHERE i.invoice_id = ${id}`;
  return row;
}

export type InvoiceLine = {
  appointment_id: string; starts_at: Date; patient_ref: string | null; is_new_patient: boolean;
  rate_cents: number; outcome: string; outcome_source: string | null; late: boolean;
};

export const invoiceLines = (id: string) => sql<InvoiceLine>`
  SELECT a.appointment_id, a.starts_at, a.patient_ref, a.is_new_patient, a.rate_cents,
         a.outcome, a.outcome_source,
         pps.local_day(a.starts_at, c.timezone) < i.period_start AS late
    FROM pps.appointments a
    JOIN pps.invoices i ON i.invoice_id = a.invoice_id
    JOIN pps.clinics c ON c.clinic_id = a.clinic_id
   WHERE a.invoice_id = ${id}
   ORDER BY a.starts_at`;

export type AppliedCredit = {
  credit_id: string; amount_cents: number; reason: string; dispute_id: string | null;
  appointment_id: string | null; credit_total_cents: number;
};

export const appliedCredits = (id: string) => sql<AppliedCredit>`
  SELECT cr.credit_id::text AS credit_id, ca.amount_cents, cr.reason,
         cr.dispute_id::text AS dispute_id, d.appointment_id, cr.amount_cents AS credit_total_cents
    FROM pps.credit_applications ca
    JOIN pps.credits cr ON cr.credit_id = ca.credit_id
    LEFT JOIN pps.disputes d ON d.dispute_id = cr.dispute_id
   WHERE ca.invoice_id = ${id}
   ORDER BY cr.created_at, cr.credit_id`;

// ---------------------------------------------------------------------------
// Disputes

export type DisputeRow = {
  dispute_id: string; appointment_id: string; raised_at: Date; raised_by: string; reason: string;
  resolution: string | null; resolved_at: Date | null; clinic_id: string; clinic_name: string;
  timezone: string; currency: string; starts_at: Date; rate_cents: number | null;
  invoice_id: string | null; invoice_number: string | null; invoice_status: string | null;
};

export function listDisputes({ open, appointment }: { open?: boolean; appointment?: string }) {
  const o = open === undefined ? null : open;
  const a = appointment ?? null;
  return sql<DisputeRow>`
    SELECT d.dispute_id::text AS dispute_id, d.appointment_id, d.raised_at, d.raised_by, d.reason,
           d.resolution, d.resolved_at, ap.clinic_id, c.name AS clinic_name, c.timezone, c.currency,
           ap.starts_at, ap.rate_cents, ap.invoice_id, i.number AS invoice_number, i.status AS invoice_status
      FROM pps.disputes d
      JOIN pps.appointments ap ON ap.appointment_id = d.appointment_id
      JOIN pps.clinics c ON c.clinic_id = ap.clinic_id
      LEFT JOIN pps.invoices i ON i.invoice_id = ap.invoice_id
     WHERE (${o}::boolean IS NULL OR (d.resolved_at IS NULL) = ${o}::boolean)
       AND (${a}::text IS NULL OR d.appointment_id = ${a}::text)
     ORDER BY CASE WHEN d.resolved_at IS NULL THEN d.raised_at END ASC NULLS LAST,
              d.resolved_at DESC
     LIMIT 300`;
}

export async function disputeCounts() {
  const [r] = await sql<{ open: number; resolved: number }>`
    SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
           count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved
      FROM pps.disputes`;
  return r;
}

export type DisputeDetail = DisputeRow & {
  evidence: Record<string, string | number | null>; resolved_by: string | null; note: string | null;
  outcome: string; billing: string; credit_id: string | null; credit_cents: number | null;
};

export async function getDispute(id: string) {
  const [row] = await sql<DisputeDetail>`
    SELECT d.dispute_id::text AS dispute_id, d.appointment_id, d.raised_at, d.raised_by, d.reason,
           d.evidence, d.resolution, d.resolved_at, d.resolved_by, d.note,
           ap.clinic_id, c.name AS clinic_name, c.timezone, c.currency, ap.starts_at,
           ap.outcome, ap.billing, ap.rate_cents,
           ap.invoice_id, i.number AS invoice_number, i.status AS invoice_status,
           cr.credit_id::text AS credit_id, cr.amount_cents AS credit_cents
      FROM pps.disputes d
      JOIN pps.appointments ap ON ap.appointment_id = d.appointment_id
      JOIN pps.clinics c ON c.clinic_id = ap.clinic_id
      LEFT JOIN pps.invoices i ON i.invoice_id = ap.invoice_id
      LEFT JOIN pps.credits cr ON cr.dispute_id = d.dispute_id
     WHERE d.dispute_id = ${id}::bigint`;
  return row;
}

export const creditUse = (creditId: string) => sql<{
  invoice_id: string; number: string | null; status: string; amount_cents: number;
}>`
  SELECT i.invoice_id, i.number, i.status, ca.amount_cents
    FROM pps.credit_applications ca
    JOIN pps.invoices i ON i.invoice_id = ca.invoice_id
   WHERE ca.credit_id = ${creditId}::bigint AND i.status <> 'void'
   ORDER BY i.period_start`;

// ---------------------------------------------------------------------------
// Clinics

export type ClinicDetail = {
  clinic_id: string; name: string; timezone: string; status: string; billing_period: string;
  minimum_cents: number; currency: string; bills_returning: boolean; contract_start: string;
  rate_cents: number | null; local_today: string;
};

export async function getClinic(id: string) {
  const [row] = await sql<ClinicDetail>`
    SELECT clinic_id, name, timezone, status, billing_period, minimum_cents, currency,
           bills_returning, contract_start::text AS contract_start,
           pps.rate_on(clinic_id, pps.local_day(now(), timezone)) AS rate_cents,
           pps.local_day(now(), timezone)::text AS local_today
      FROM pps.clinics WHERE clinic_id = ${id}`;
  return row;
}

export const clinicRates = (id: string) => sql<{
  effective_from: string; rate_cents: number; created_by: string; created_at: Date;
}>`
  SELECT effective_from::text AS effective_from, rate_cents, created_by, created_at
    FROM pps.clinic_rates WHERE clinic_id = ${id}
   ORDER BY effective_from DESC`;

export const clinicCredits = (id: string) => sql<{
  credit_id: string; amount_cents: number; available_cents: number; reason: string;
  dispute_id: string | null; created_at: Date;
}>`
  SELECT credit_id::text AS credit_id, amount_cents, pps.credit_available(credit_id) AS available_cents,
         reason, dispute_id::text AS dispute_id, created_at
    FROM pps.credits WHERE clinic_id = ${id}
   ORDER BY created_at DESC`;

// ---------------------------------------------------------------------------
// Activity

export const ACTIVITY_ENTITIES = ['appointment', 'invoice', 'dispute', 'clinic', 'demo'] as const;

export type ActivityRow = {
  activity_id: string; at: Date; actor: string; action: string; entity: string;
  entity_id: string | null; clinic_id: string | null; clinic_name: string | null; currency: string | null;
  detail: Record<string, any>; invoice_number: string | null; total: number;
};

export function listActivity({ entity, entityId, page = 0, limit = PAGE_SIZE }: {
  entity?: string; entityId?: string; page?: number; limit?: number;
}) {
  const e = entity ?? null;
  const id = entityId ?? null;
  return sql<ActivityRow>`
    SELECT a.activity_id::text AS activity_id, a.at, a.actor, a.action, a.entity, a.entity_id,
           a.clinic_id, c.name AS clinic_name, c.currency, a.detail,
           i.number AS invoice_number,
           count(*) OVER ()::int AS total
      FROM pps.activity a
      LEFT JOIN pps.clinics c ON c.clinic_id = a.clinic_id
      LEFT JOIN pps.invoices i ON a.entity = 'invoice' AND i.invoice_id = a.entity_id
     WHERE (${e}::text IS NULL OR a.entity = ${e}::text)
       AND (${id}::text IS NULL OR a.entity_id = ${id}::text)
     ORDER BY a.at DESC, a.activity_id DESC
     LIMIT ${limit} OFFSET ${page * limit}`;
}
