import { neon } from '@neondatabase/serverless';

// Lazily constructed: Next imports this at build time to collect page data,
// and DATABASE_URL is a runtime value.
let sql: ReturnType<typeof neon> | null = null;
const db = () => (sql ??= neon(process.env.DATABASE_URL!));

export const RANGES = [7, 30, 90, 365] as const;
export type Range = (typeof RANGES)[number];

export function parseRange(v: string | undefined): Range {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? (n as Range) : 90;
}

/** Sorting is applied in JS: the driver takes values, not identifiers. */
export function sortRows<T extends Record<string, any>>(
  rows: T[],
  key: string | undefined,
  dir: string | undefined,
  allowed: string[],
): T[] {
  if (!key || !allowed.includes(key)) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const nx = Number(x);
    const ny = Number(y);
    if (x !== null && y !== null && !Number.isNaN(nx) && !Number.isNaN(ny)) {
      return (nx - ny) * sign;
    }
    return String(x ?? '').localeCompare(String(y ?? '')) * sign;
  });
}

export type Clinic = {
  clinic_id: string;
  business_name: string;
  rate_per_show_cents: number;
  status: string;
  bills_returning: boolean;
};

export async function getClinics() {
  return (await db()`
    SELECT clinic_id, business_name, rate_per_show_cents, status, bills_returning
      FROM clinics ORDER BY business_name
  `) as Clinic[];
}

export type Summary = {
  ready_shows: number;
  ready_usd: string;
  unmarked: number;
  unmarked_usd: string;
  open_disputes: number;
  invoiced_usd: string;
};

export async function getSummary(days: Range, clinic: string | null) {
  const rows = (await db()`
    WITH win AS (
      SELECT * FROM billable_events
       WHERE starts_at >= now() - make_interval(days => ${days})
         AND starts_at <  now()
         AND (${clinic}::text IS NULL OR clinic_id = ${clinic})
    )
    SELECT
      (SELECT count(*) FROM win w
        WHERE w.outcome = 'attended' AND w.state = 'billable'
          AND w.invoice_id IS NULL)::int                            AS ready_shows,
      COALESCE((SELECT sum(w.rate_cents) / 100.0 FROM win w
        WHERE w.outcome = 'attended' AND w.state = 'billable'
          AND w.invoice_id IS NULL), 0)::numeric(12,2)              AS ready_usd,
      (SELECT count(*) FROM win w
        WHERE w.outcome = 'unmarked')::int                          AS unmarked,
      COALESCE((SELECT sum(c.rate_per_show_cents) / 100.0 FROM win w
        JOIN clinics c USING (clinic_id)
       WHERE w.outcome = 'unmarked'), 0)::numeric(12,2)             AS unmarked_usd,
      (SELECT count(*) FROM disputes d
        JOIN win w USING (appointment_id)
       WHERE d.resolved_at IS NULL)::int                            AS open_disputes,
      COALESCE((SELECT sum(w.rate_cents) / 100.0 FROM win w
        WHERE w.invoice_id IS NOT NULL), 0)::numeric(12,2)          AS invoiced_usd
  `) as Summary[];
  return rows[0];
}

export type UnmarkedRow = {
  clinic_id: string;
  business_name: string;
  unmarked: number;
  revenue_at_risk_usd: string;
  unmarked_pct: string;
  avg_days_stale: string;
  oldest: string;
};

export async function getUnmarked(days: Range, clinic: string | null) {
  return (await db()`
    WITH win AS (
      SELECT * FROM billable_events
       WHERE starts_at >= now() - make_interval(days => ${days})
         AND starts_at <  now() - interval '24 hours'
         AND (${clinic}::text IS NULL OR clinic_id = ${clinic})
    ), past AS (
      SELECT clinic_id, count(*) AS appointments FROM win GROUP BY 1
    )
    SELECT w.clinic_id, c.business_name,
           count(*)::int                                          AS unmarked,
           round((count(*) * c.rate_per_show_cents / 100.0)::numeric, 2)
                                                                  AS revenue_at_risk_usd,
           round(100.0 * count(*) / p.appointments, 1)             AS unmarked_pct,
           round(avg(extract(epoch FROM now() - w.starts_at) / 86400)::numeric, 1)
                                                                  AS avg_days_stale,
           min(w.starts_at)                                       AS oldest
      FROM win w
      JOIN clinics c USING (clinic_id)
      JOIN past p    USING (clinic_id)
     WHERE w.outcome = 'unmarked'
     GROUP BY w.clinic_id, c.business_name, c.rate_per_show_cents, p.appointments
     ORDER BY revenue_at_risk_usd DESC
  `) as UnmarkedRow[];
}

export type UnbilledRow = {
  clinic_id: string;
  business_name: string;
  shows: number;
  value_usd: string;
  oldest: string;
  newest: string;
};

export async function getUnbilled(days: Range, clinic: string | null) {
  return (await db()`
    SELECT b.clinic_id, c.business_name,
           count(*)::int                                  AS shows,
           round((sum(b.rate_cents) / 100.0)::numeric, 2)  AS value_usd,
           min(b.starts_at) AS oldest,
           max(b.starts_at) AS newest
      FROM billable_events b
      JOIN clinics c USING (clinic_id)
     WHERE b.outcome = 'attended' AND b.state = 'billable'
       AND b.invoice_id IS NULL
       AND b.starts_at >= now() - make_interval(days => ${days})
       AND b.starts_at <  now()
       AND (${clinic}::text IS NULL OR b.clinic_id = ${clinic})
     GROUP BY b.clinic_id, c.business_name
     ORDER BY value_usd DESC
  `) as UnbilledRow[];
}

export type ShowRateRow = {
  clinic_id: string;
  business_name: string;
  resolved: number;
  attended: number;
  no_shows: number;
  cancelled: number;
  unmarked: number;
  show_rate_pct: string | null;
};

export async function getShowRates(days: Range, clinic: string | null) {
  return (await db()`
    SELECT b.clinic_id, c.business_name,
           count(*) FILTER (WHERE outcome IN ('attended','no_show'))::int AS resolved,
           count(*) FILTER (WHERE outcome = 'attended')::int              AS attended,
           count(*) FILTER (WHERE outcome = 'no_show')::int               AS no_shows,
           count(*) FILTER (WHERE outcome = 'cancelled')::int             AS cancelled,
           count(*) FILTER (WHERE outcome = 'unmarked')::int              AS unmarked,
           round(100.0 * count(*) FILTER (WHERE outcome = 'attended')
                 / nullif(count(*) FILTER (WHERE outcome IN ('attended','no_show')), 0), 1)
                                                                          AS show_rate_pct
      FROM billable_events b
      JOIN clinics c USING (clinic_id)
     WHERE b.starts_at >= now() - make_interval(days => ${days})
       AND b.starts_at <  now()
       AND (${clinic}::text IS NULL OR b.clinic_id = ${clinic})
     GROUP BY b.clinic_id, c.business_name
     ORDER BY show_rate_pct NULLS LAST
  `) as ShowRateRow[];
}

export type DisputeRow = {
  dispute_id: number;
  appointment_id: string;
  business_name: string;
  clinic_id: string;
  raised_at: string;
  raised_by: string;
  reason: string;
  resolution: string | null;
  resolved_at: string | null;
  evidence: Record<string, unknown> | null;
  note: string | null;
};

export async function getDisputes(
  days: Range,
  clinic: string | null,
  status: 'open' | 'resolved' | 'all',
) {
  return (await db()`
    SELECT d.dispute_id, d.appointment_id, d.raised_at, d.raised_by, d.reason,
           d.resolution, d.resolved_at, d.evidence, d.note,
           c.business_name, b.clinic_id
      FROM disputes d
      JOIN billable_events b USING (appointment_id)
      JOIN clinics c ON c.clinic_id = b.clinic_id
     WHERE b.starts_at >= now() - make_interval(days => ${days})
       AND (${clinic}::text IS NULL OR b.clinic_id = ${clinic})
       AND (${status} = 'all'
            OR (${status} = 'open'     AND d.resolved_at IS NULL)
            OR (${status} = 'resolved' AND d.resolved_at IS NOT NULL))
     ORDER BY d.raised_at DESC
  `) as DisputeRow[];
}

export type EventRow = {
  appointment_id: string;
  starts_at: string;
  outcome: string;
  outcome_at: string | null;
  outcome_source: string | null;
  state: string;
  rate_cents: number | null;
  invoice_id: string | null;
  is_new_patient: boolean;
  booked_by: string | null;
  booked_at: string;
};

export const PAGE_SIZE = 50;

/** One clinic's appointments, for the drill-down. Paged. */
export async function getEvents(
  clinic: string,
  days: Range,
  outcome: string | null,
  page = 0,
  limit = PAGE_SIZE,
) {
  return (await db()`
    SELECT appointment_id, starts_at, outcome, outcome_at, outcome_source,
           state, rate_cents, invoice_id, is_new_patient, booked_by, booked_at
      FROM billable_events
     WHERE clinic_id = ${clinic}
       AND starts_at >= now() - make_interval(days => ${days})
       AND (${outcome}::text IS NULL OR outcome = ${outcome})
     ORDER BY starts_at DESC
     LIMIT ${limit} OFFSET ${page * limit}
  `) as EventRow[];
}

/** Total matching rows, so the pager knows where it ends. */
export async function countEvents(
  clinic: string,
  days: Range,
  outcome: string | null,
) {
  const rows = (await db()`
    SELECT count(*)::int AS n
      FROM billable_events
     WHERE clinic_id = ${clinic}
       AND starts_at >= now() - make_interval(days => ${days})
       AND (${outcome}::text IS NULL OR outcome = ${outcome})
  `) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Every matching row, for CSV. Export should not stop at a page boundary. */
export async function getAllEvents(
  clinic: string,
  days: Range,
  outcome: string | null,
  limit = 5000,
) {
  return (await db()`
    SELECT appointment_id, starts_at, outcome, outcome_at, outcome_source,
           state, rate_cents, invoice_id, is_new_patient, booked_by, booked_at
      FROM billable_events
     WHERE clinic_id = ${clinic}
       AND starts_at >= now() - make_interval(days => ${days})
       AND (${outcome}::text IS NULL OR outcome = ${outcome})
     ORDER BY starts_at DESC
     LIMIT ${limit}
  `) as EventRow[];
}

export type InvoiceRow = {
  invoice_id: string;
  period_start: string;
  period_end: string;
  shows_count: number;
  total_cents: number;
  status: string;
  issued_at: string | null;
};

export async function getInvoices(clinic: string, limit = 12) {
  return (await db()`
    SELECT invoice_id, period_start, period_end, shows_count,
           total_cents, status, issued_at
      FROM invoices
     WHERE clinic_id = ${clinic}
     ORDER BY period_start DESC
     LIMIT ${limit}
  `) as InvoiceRow[];
}

export const money = (v: string | number | null | undefined) =>
  '$' +
  Number(v ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const sum = (rows: Record<string, unknown>[], key: string) =>
  rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);
