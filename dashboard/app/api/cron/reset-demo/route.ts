import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Called nightly by Vercel Cron, which sends CRON_SECRET as a bearer token.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const [{ r }] = await sql<{ r: Record<string, number> }>`SELECT pps.reset_demo('nightly reset') AS r`;
  return Response.json({ ok: true, ...r });
}
