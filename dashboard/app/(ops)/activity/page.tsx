import Link from 'next/link';
import { Empty, PageHeader, Pager, Tabs } from '@/components/ui';
import { ACTION_LABEL, activitySubject, describeActivity } from '@/lib/activity';
import { requireUser } from '@/lib/auth';
import { AGENCY_TZ, DASH, oneOf, pageNumber, param, qs, when } from '@/lib/format';
import { ACTIVITY_ENTITIES, PAGE_SIZE, listActivity } from '@/lib/queries';

export const metadata = { title: 'Activity' };

const TABS: [(typeof ACTIVITY_ENTITIES)[number] | undefined, string][] = [
  [undefined, 'All'],
  ['appointment', 'Appointments'],
  ['invoice', 'Invoices'],
  ['dispute', 'Disputes'],
  ['clinic', 'Clinics'],
];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const entity = oneOf(param(sp, 'entity'), ACTIVITY_ENTITIES);
  const page = pageNumber(param(sp, 'page'));
  const rows = await listActivity({ entity, page });
  const total = rows[0]?.total ?? 0;

  return (
    <>
      <PageHeader title="Activity" meta="Every change to billing, who made it and when. Nothing here can be edited." />
      <Tabs items={TABS.map(([value, text]) => ({ href: qs('/activity', { entity: value }), label: text, active: entity === value }))} />

      {rows.length === 0 ? (
        <Empty>No changes recorded yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Record</th>
                <th>Clinic</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const subject = activitySubject(r);
                return (
                  <tr key={r.activity_id}>
                    <td className="muted">{when(r.at, AGENCY_TZ, { zone: true })}</td>
                    <td>{r.actor}</td>
                    <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                    <td>{subject ? <Link href={subject.href} className="mono">{subject.text}</Link> : DASH}</td>
                    <td>{r.clinic_name ?? DASH}</td>
                    <td className="wrap">{describeActivity(r) || DASH}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        page={page}
        total={total}
        size={PAGE_SIZE}
        href={(p) => qs('/activity', { entity, page: p > 0 ? p + 1 : undefined })}
      />
    </>
  );
}
