# Dashboard

The screen somebody opens on a Monday. Next.js on Vercel, reading the views
directly.

```bash
npm install
echo 'DATABASE_URL=postgresql://...' > .env.local
npm run dev
```

Deploy:

```bash
npx vercel
npx vercel env add DATABASE_URL
npx vercel --prod
```

One environment variable. Nothing else to configure.

---

## What's on it

**Four tiles** — ready to invoice, not invoiced because nobody marked, clinics
gone quiet, open disputes.

**Appointments nobody marked** — the table this repo exists for. Clinics
averaging a week or more without recording an outcome are flagged in red, with
the reason spelled out: *front desk has stopped recording*.

**Ready to invoice** — attended, billable under the contract, not yet on an
invoice.

**Show rate** — attended over resolved, cancellations excluded. Anything under
55% is flagged with the diagnosis rather than the number: *check the
confirmation step, not the ads*.

**Open disputes** — only when there are any.

## Design decisions

**Read-only.** The dashboard never writes. Billing state changes belong to the
n8n workflows, where they are logged and idempotent. A dashboard that can mutate
an invoice is a dashboard that eventually will, by accident, at 5pm on a Friday.

**`force-dynamic`, no caching.** A billing figure cached for an hour is a
billing figure somebody quotes to a client wrongly.

**Tabular figures everywhere.** Money that jitters between rows is money nobody
trusts.

**Rows carry the diagnosis, not just the number.** A red row that says *front
desk has stopped recording* gets acted on. A red row that says `-$1,520` gets
argued about.

**Light and dark both defined.** It renders on whatever the viewer's system is
set to.

## Verified

```
tsc --noEmit    exit 0
next build      compiled successfully, 3/3 static pages
```
