import Link from 'next/link';
import { Badge, PageHeader } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { DASH, money } from '@/lib/format';
import { clinicHealth } from '@/lib/queries';

export const metadata = { title: 'Clinics' };

export default async function ClinicsPage() {
  await requireUser();
  const clinics = await clinicHealth();

  return (
    <>
      <PageHeader title="Clinics" meta="Contract terms, and how each clinic has done over the last 30 days." />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Clinic</th>
              <th>Timezone</th>
              <th>Billing</th>
              <th className="num">Rate</th>
              <th className="num">Minimum</th>
              <th>Returning patients</th>
              <th className="num">Attended</th>
              <th className="num">Show rate</th>
              <th className="num">Unmarked</th>
              <th className="num">Outstanding</th>
              <th className="num">Open disputes</th>
            </tr>
          </thead>
          <tbody>
            {clinics.map((c) => (
              <tr key={c.clinic_id}>
                <td><Link href={`/clinics/${c.clinic_id}`}>{c.name}</Link></td>
                <td className="muted">{c.timezone.replace('America/', '').replace('_', ' ')}</td>
                <td className="muted">{c.billing_period === 'weekly' ? 'Weekly' : 'Monthly'}</td>
                <td className="num mono">{money(c.rate_cents, c.currency)}</td>
                <td className="num mono">{c.minimum_cents ? money(c.minimum_cents, c.currency) : DASH}</td>
                <td>{c.bills_returning ? 'Billed' : 'Not billed'}</td>
                <td className="num">{c.attended}</td>
                <td className="num">
                  {c.show_rate === null ? DASH
                    : Number(c.show_rate) < 55 ? <Badge tone="amber">{c.show_rate}%</Badge>
                    : `${c.show_rate}%`}
                </td>
                <td className="num">{c.unmarked || DASH}</td>
                <td className="num mono">{c.outstanding_cents ? money(c.outstanding_cents, c.currency) : DASH}</td>
                <td className="num">{c.open_disputes || DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
