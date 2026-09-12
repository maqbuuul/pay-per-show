import {
  getAllEvents, getDisputes, getShowRates, getUnbilled, getUnmarked, parseRange,
} from '@/lib/db';

export const dynamic = 'force-dynamic';

function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    // The driver hands back Date objects. String() would render them in the
    // server's zone as "Thu Aug 27 2026 ... (East Africa Time)", which no
    // spreadsheet parses. ISO 8601 does, and it carries the offset.
    const s = v instanceof Date ? v.toISOString() : String(v);
    // Quote anything a spreadsheet would otherwise split or reinterpret.
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const table = url.searchParams.get('table') ?? 'unmarked';
  const days = parseRange(url.searchParams.get('range') ?? undefined);
  const clinic = url.searchParams.get('clinic') || null;

  let rows: Record<string, unknown>[] = [];
  switch (table) {
    case 'unmarked':
      rows = await getUnmarked(days, clinic);
      break;
    case 'unbilled':
      rows = await getUnbilled(days, clinic);
      break;
    case 'showrate':
      rows = await getShowRates(days, clinic);
      break;
    case 'disputes':
      rows = await getDisputes(days, clinic, 'all');
      break;
    case 'events':
      if (!clinic) return new Response('clinic required', { status: 400 });
      rows = await getAllEvents(clinic, days, url.searchParams.get("outcome") || null);
      break;
    default:
      return new Response('unknown table', { status: 400 });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${table}-${clinic ?? 'all'}-${days}d-${stamp}.csv`;

  return new Response(csv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}
