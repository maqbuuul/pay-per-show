import { OUTCOME, RESOLUTION, day, label, money, period } from './format';
import type { ActivityRow } from './queries';

export const ACTION_LABEL: Record<string, string> = {
  'appointment.outcome': 'Changed outcome',
  'invoice.drafted': 'Drafted invoice',
  'invoice.refreshed': 'Refreshed draft',
  'invoice.sent': 'Sent invoice',
  'invoice.paid': 'Recorded payment',
  'invoice.voided': 'Voided invoice',
  'dispute.raised': 'Opened dispute',
  'dispute.resolved': 'Resolved dispute',
  'clinic.rate_set': 'Set rate',
  'demo.reset': 'Reset demo data',
};

export function describeActivity(a: ActivityRow): string {
  const d = a.detail ?? {};
  const currency = a.currency ?? 'USD';
  switch (a.action) {
    case 'appointment.outcome':
      return `${label(OUTCOME, d.from)} to ${label(OUTCOME, d.to)}${d.source === 'calendar' ? ', from the calendar' : ''}`;
    case 'invoice.drafted':
    case 'invoice.refreshed':
      return `${period(d.period_start, d.period_end)}, ${d.shows_added} ${d.shows_added === 1 ? 'show' : 'shows'} added`;
    case 'invoice.sent':
    case 'invoice.paid':
      return `${d.number}, ${money(d.total_cents, currency)}`;
    case 'invoice.voided':
      return `${d.number ?? 'Draft'}: ${d.reason}`;
    case 'dispute.raised':
      return String(d.reason ?? '');
    case 'dispute.resolved':
      return `${label(RESOLUTION, d.resolution)}${d.credit_cents ? `, ${money(d.credit_cents, currency)} credit` : ''}`;
    case 'clinic.rate_set':
      return `${d.from_cents ? money(d.from_cents, currency) : 'No rate'} to ${money(d.to_cents, currency)} from ${day(d.effective_from)}`;
    case 'demo.reset':
      return `${d.appointments} appointments, ${d.invoices} invoices`;
    default:
      return '';
  }
}

export function activitySubject(a: ActivityRow): { href: string; text: string } | null {
  if (!a.entity_id) return null;
  switch (a.entity) {
    case 'appointment':
      return { href: `/appointments/${encodeURIComponent(a.entity_id)}`, text: a.entity_id };
    case 'invoice':
      return { href: `/invoices/${a.entity_id}`, text: a.invoice_number ?? 'Draft invoice' };
    case 'dispute':
      return { href: `/disputes/${a.entity_id}`, text: `Dispute #${a.entity_id}` };
    case 'clinic':
      return { href: `/clinics/${a.entity_id}`, text: a.clinic_name ?? a.entity_id };
    default:
      return null;
  }
}
