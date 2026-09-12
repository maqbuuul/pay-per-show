import Link from 'next/link';
import type { Clinic, Range } from '@/lib/db';
import { RANGES } from '@/lib/db';

export type Query = Record<string, string | undefined>;

/** Build a URL preserving the current query, overriding some keys. */
export function href(base: string, q: Query, patch: Query) {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...patch })) {
    if (v !== undefined && v !== null && v !== '') next.set(k, String(v));
  }
  const s = next.toString();
  return s ? `${base}?${s}` : base;
}

export function FilterBar({
  base, q, days, clinics, clinic,
}: {
  base: string;
  q: Query;
  days: Range;
  clinics: Clinic[];
  clinic: string | null;
}) {
  return (
    <div className="filters">
      <div className="fgroup">
        <span className="flabel">Range</span>
        {RANGES.map((r) => (
          <Link
            key={r}
            href={href(base, q, { range: String(r), page: undefined })}
            className={`chip ${r === days ? 'on' : ''}`}
          >
            {r === 365 ? '12m' : `${r}d`}
          </Link>
        ))}
      </div>

      <div className="fgroup">
        <span className="flabel">Clinic</span>
        <Link
          href={href(base, q, { clinic: undefined })}
          className={`chip ${!clinic ? 'on' : ''}`}
        >
          All
        </Link>
        {clinics.map((c) => (
          <Link
            key={c.clinic_id}
            href={href(base, q, { clinic: c.clinic_id })}
            className={`chip ${clinic === c.clinic_id ? 'on' : ''}`}
          >
            {c.business_name.split(' ')[0]}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** A column header that toggles sort direction on click. */
export function SortTh({
  label, col, base, q, numeric = false,
}: {
  label: string;
  col: string;
  base: string;
  q: Query;
  numeric?: boolean;
}) {
  const active = q.sort === col;
  const nextDir = active && q.dir === 'desc' ? 'asc' : 'desc';
  return (
    <th className={numeric ? 'n' : ''}>
      <Link
        href={href(base, q, { sort: col, dir: nextDir })}
        className={`sortlink ${active ? 'on' : ''}`}
      >
        {label}
        <span className="caret">{active ? (q.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </Link>
    </th>
  );
}

export function ExportLink({ q, table }: { q: Query; table: string }) {
  return (
    <a className="export" href={href('/api/export', q, { table })}>
      Export CSV
    </a>
  );
}
