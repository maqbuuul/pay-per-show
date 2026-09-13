import { ACTION_LABEL, describeActivity } from '@/lib/activity';
import { AGENCY_TZ, when } from '@/lib/format';
import type { ActivityRow } from '@/lib/queries';

export function History({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) return <p className="muted">No changes recorded yet.</p>;
  return (
    <ul className="history">
      {rows.map((r) => (
        <li key={r.activity_id}>
          <time dateTime={new Date(r.at).toISOString()}>{when(r.at, AGENCY_TZ)}</time>
          <div>
            <span className="history-action">{ACTION_LABEL[r.action] ?? r.action}</span>
            <span className="muted"> by {r.actor}</span>
            <div className="history-detail">{describeActivity(r)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
