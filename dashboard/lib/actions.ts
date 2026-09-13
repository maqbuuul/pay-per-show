'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { requireUser } from './auth';
import { businessError, sql } from './db';
import { OUTCOME, money, plural } from './format';

export type ActionResult = { ok: true; message: string } | { ok: false; error: string } | null;

const GENERIC = 'Something went wrong and nothing was changed. Try again.';

async function run(work: (actor: string) => Promise<string>): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const message = await work(user.email);
    // Shown by the layout once the page re-renders. The form that ran the
    // action is often gone by then: a sent invoice has no Send button.
    (await cookies()).set('pps_flash', `${Date.now()}|${message}`, { path: '/', maxAge: 30, sameSite: 'lax' });
    revalidatePath('/', 'layout');
    return { ok: true, message };
  } catch (e) {
    const message = businessError(e);
    if (!message) console.error(e);
    return { ok: false, error: message ?? GENERIC };
  }
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

const SKIPPED: Record<string, string> = {
  unchanged: 'already had that outcome',
  locked_invoice: 'on a sent invoice, so raise a dispute instead',
  future: 'not happened yet',
  written_off: 'written off',
  no_rate: 'no rate in force on that date',
  not_found: 'not found',
};

export async function markOutcomes(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const ids = form.getAll('ids').map(String).filter(Boolean);
  const outcome = text(form, 'outcome');
  if (ids.length === 0) return { ok: false, error: 'Select at least one appointment.' };
  if (!OUTCOME[outcome]) return { ok: false, error: 'Choose an outcome.' };

  return run(async (actor) => {
    const [{ r }] = await sql<{ r: { appointment_id: string; result: string }[] }>`
      SELECT pps.mark_outcome(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)),
                              ${outcome}, ${actor}) AS r`;
    const counts = new Map<string, number>();
    for (const x of r) counts.set(x.result, (counts.get(x.result) ?? 0) + 1);

    const parts = [`Marked ${plural(counts.get('changed') ?? 0, 'appointment')} as ${OUTCOME[outcome].toLowerCase()}.`];
    for (const [result, n] of counts) {
      if (result !== 'changed') parts.push(`Skipped ${n}: ${SKIPPED[result] ?? result}.`);
    }
    return parts.join(' ');
  });
}

export async function draftInvoices(_prev: ActionResult, _form: FormData): Promise<ActionResult> {
  return run(async (actor) => {
    const [{ r }] = await sql<{ r: { result: string }[] }>`
      SELECT pps.draft_invoices(NULL::date, ${actor}) AS r`;
    const n = (result: string) => r.filter((x) => x.result === result).length;
    const parts = [];
    if (n('drafted')) parts.push(`Drafted ${plural(n('drafted'), 'invoice')}.`);
    if (n('refreshed')) parts.push(`Refreshed ${plural(n('refreshed'), 'draft')}.`);
    if (n('nothing_to_bill')) parts.push(`${plural(n('nothing_to_bill'), 'clinic')} had nothing to bill.`);
    return parts.join(' ') || 'Every closed period already has an invoice.';
  });
}

export async function refreshDraft(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = text(form, 'invoice_id');
  return run(async (actor) => {
    const [row] = await sql<{ r: { result: string } }>`
      SELECT pps.draft_invoice_for(clinic_id, period_start, period_end, ${actor}) AS r
        FROM pps.invoices WHERE invoice_id = ${id} AND status = 'draft'`;
    if (!row) return 'This invoice is no longer a draft.';
    return row.r.result === 'nothing_to_bill'
      ? 'Nothing is left to bill for this period, so the draft was removed.'
      : 'Draft refreshed with the latest billable shows and credits.';
  });
}

export async function sendInvoice(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = text(form, 'invoice_id');
  return run(async (actor) => {
    const [{ r }] = await sql<{ r: { number: string; changed: boolean } }>`
      SELECT pps.send_invoice(${id}, ${actor}) AS r`;
    return r.changed ? `Sent as ${r.number}.` : `Already sent as ${r.number}.`;
  });
}

export async function recordPayment(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = text(form, 'invoice_id');
  return run(async (actor) => {
    const [{ r }] = await sql<{ r: { changed: boolean } }>`
      SELECT pps.record_payment(${id}, ${actor}) AS r`;
    return r.changed ? 'Payment recorded.' : 'This invoice was already marked paid.';
  });
}

export async function voidInvoice(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = text(form, 'invoice_id');
  const reason = text(form, 'reason');
  return run(async (actor) => {
    await sql`SELECT pps.void_invoice(${id}, ${reason}, ${actor})`;
    return 'Invoice voided. Its shows and credits are free for the next draft.';
  });
}

export async function raiseDispute(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = text(form, 'appointment_id');
  const reason = text(form, 'reason');
  const raisedBy = text(form, 'raised_by');
  return run(async (actor) => {
    const [{ r }] = await sql<{ r: { dispute_id: number } }>`
      SELECT pps.raise_dispute(${id}, ${reason}, ${raisedBy}, ${actor}) AS r`;
    return `Dispute #${r.dispute_id} opened.`;
  });
}

export async function resolveDispute(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = text(form, 'dispute_id');
  const resolution = text(form, 'resolution');
  const note = text(form, 'note');
  if (!['upheld', 'rejected', 'goodwill'].includes(resolution)) {
    return { ok: false, error: 'Choose how to resolve the dispute.' };
  }
  return run(async (actor) => {
    const [{ r }] = await sql<{ r: { credit_id: number | null; changed: boolean } }>`
      SELECT pps.resolve_dispute(${id}::bigint, ${resolution}, ${note}, ${actor}) AS r`;
    if (!r.changed) return 'This dispute was already resolved that way.';
    return r.credit_id ? 'Dispute resolved. A credit will come off the next invoice.' : 'Dispute resolved.';
  });
}

export async function setRate(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const clinicId = text(form, 'clinic_id');
  const amount = text(form, 'amount').replace(/[$,\s]/g, '');
  const effectiveFrom = text(form, 'effective_from');
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    return { ok: false, error: 'Enter the rate as an amount, for example 95 or 95.50.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return { ok: false, error: 'Choose the date the new rate takes effect.' };
  }
  const cents = Math.round(Number(amount) * 100);
  return run(async (actor) => {
    await sql`SELECT pps.set_rate(${clinicId}, ${cents}, ${effectiveFrom}::date, ${actor})`;
    return `New rate of ${money(cents)} saved.`;
  });
}

export async function resetDemo(_prev: ActionResult, _form: FormData): Promise<ActionResult> {
  return run(async (actor) => {
    await sql`SELECT pps.reset_demo(${actor})`;
    return 'Demo data reset.';
  });
}
