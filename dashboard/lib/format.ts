export const DASH = '—';
export const NET_DAYS = 14;
export const AGENCY_TZ = process.env.AGENCY_TZ ?? 'America/New_York';

export const OUTCOME: Record<string, string> = {
  unmarked: 'Unmarked',
  attended: 'Attended',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

export const BILLING: Record<string, string> = {
  not_billable: 'Not billable',
  billable: 'Billable',
  invoiced: 'Invoiced',
  written_off: 'Written off',
};

export const RESOLUTION: Record<string, string> = {
  upheld: 'Upheld',
  rejected: 'Rejected',
  goodwill: 'Goodwill credit',
};

export function label(map: Record<string, string>, key: string | null | undefined) {
  if (!key) return DASH;
  return map[key] ?? key;
}

export function money(cents: number | string | null | undefined, currency = 'USD') {
  if (cents === null || cents === undefined || cents === '') return DASH;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(cents) / 100);
}

/** Totals that may span currencies, e.g. "$1,200.00 + €300.00". */
export function moneyByCurrency(rows: { currency: string; cents: number }[]) {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.cents));
  if (totals.size === 0) return money(0);
  return [...totals].map(([currency, cents]) => money(cents, currency)).join(' + ');
}

/** A moment in a given timezone. */
export function when(
  at: string | Date | null | undefined,
  tz: string,
  { time = true, zone = false, year = false }: { time?: boolean; zone?: boolean; year?: boolean } = {},
) {
  if (!at) return DASH;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
    ...(time ? { hour: 'numeric', minute: '2-digit' } : {}),
    ...(zone ? { timeZoneName: 'short' } : {}),
  }).format(new Date(at));
}

/** A calendar date stored as YYYY-MM-DD, shown without any timezone shift. */
export function day(
  value: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
) {
  if (!value) return DASH;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts })
    .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/** "August 2026" for a whole month, otherwise "Sep 7 – Sep 13, 2026". */
export function period(start: string, end: string) {
  const s = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  const e = new Date(`${end.slice(0, 10)}T00:00:00Z`);
  const monthEnd = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
  if (s.getUTCDate() === 1 && e.getTime() === monthEnd.getTime()) {
    return day(start, { month: 'long', year: 'numeric' });
  }
  return `${day(start, { month: 'short', day: 'numeric' })} – ${day(end)}`;
}

/** Whole days between a moment and now, as "today", "1 day" or "12 days". */
export function age(at: string | Date, now = Date.now()) {
  const days = Math.floor((now - new Date(at).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

export function addDays(at: string | Date, days: number) {
  return new Date(new Date(at).getTime() + days * 86_400_000);
}

/** YYYY-MM-DD for today plus an offset, in UTC. */
export function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function qs(base: string, params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `${base}?${s}` : base;
}

type Params = Record<string, string | string[] | undefined>;

export function param(sp: Params, key: string) {
  const v = sp[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]) {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function validDay(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export function pageNumber(value: string | undefined) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 1 ? n - 1 : 0;
}
