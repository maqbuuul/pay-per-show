import { neon } from '@neondatabase/serverless';

// Read-only queries against the views. The dashboard never writes -- billing
// state changes belong to the n8n workflows, where they are logged and
// idempotent. A dashboard that can mutate an invoice is a dashboard that will,
// by accident, at 5pm on a Friday.
const sql = neon(process.env.DATABASE_URL!);

export type Unmarked = {
  clinic_id: string;
  business_name: string;
  unmarked: number;
  revenue_at_risk_usd: string;
  oldest: string;
  avg_days_stale: string;
};

export type Unbilled = {
  clinic_id: string;
  business_name: string;
  shows: number;
  value_usd: string;
  oldest: string;
  newest: string;
};

export type ShowRate = {
  clinic_id: string;
  business_name: string;
  resolved: number;
  attended: number;
  no_shows: number;
  unmarked: number;
  show_rate_pct: string | null;
};

export type Dispute = {
  dispute_id: number;
  business_name: string;
  appointment_id: string;
  raised_at: string;
  reason: string;
  resolution: string | null;
};

export async function getUnmarked() {
  return (await sql`SELECT * FROM v_unmarked_appointments`) as Unmarked[];
}

export async function getUnbilled() {
  return (await sql`
    SELECT * FROM v_unbilled_shows ORDER BY value_usd DESC
  `) as Unbilled[];
}

export async function getShowRates() {
  // The view is keyed by clinic_id; join the name on here rather than widening
  // the view, so the metric definition stays about the metric.
  return (await sql`
    SELECT r.*, c.business_name
    FROM v_clinic_show_rate r
    JOIN clinics c USING (clinic_id)
    ORDER BY r.show_rate_pct NULLS LAST
  `) as ShowRate[];
}

export async function getOpenDisputes() {
  return (await sql`
    SELECT d.dispute_id, d.appointment_id, d.raised_at, d.reason, d.resolution,
           c.business_name
    FROM disputes d
    JOIN billable_events b USING (appointment_id)
    JOIN clinics c ON c.clinic_id = b.clinic_id
    WHERE d.resolved_at IS NULL
    ORDER BY d.raised_at
  `) as Dispute[];
}

export const money = (v: string | number | null | undefined) =>
  '$' + Number(v ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const sum = (rows: { [k: string]: unknown }[], key: string) =>
  rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);
