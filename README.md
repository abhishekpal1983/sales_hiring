# Sales Hiring Tracker

Shared candidate tracker for B2C inside sales hiring. Round 1 and Round 2 scorecards,
pipeline stages, a live dashboard, and an activity feed, all backed by one database so
every interviewer sees the same records.

Replaces the earlier browser-only version, where each person's entries were trapped in
their own browser.

## What it does

- **Pipeline** — one row per candidate: stage, Round 1 score, Round 2 score, who touched it last.
- **Round 1, sales skills** (weighted to 100): communication 10, consultative selling and
  discovery 20, objection handling and negotiation 20, closing and follow-up discipline 15,
  past performance and numbers 15, process and CRM discipline 10, sales mindset 10. Sections
  2 to 4 are run as ONE continuous mock call, scored in three parts.
- **Round 2, drive and culture fit** (weighted to 100): response to being behind target 25,
  pressure handling and resilience 20, work ethic and go-getter attitude 20, competitiveness
  and ambition 15, financial motivation and dependencies 10, ownership, stability and joining
  fit 10.
- Each competency carries the full "what to assess" guide inline: questions to ask, what you
  are testing, green flags, red flags, and a 1 to 5 rating guide.
- **Stages** — Applied, Round 1, Round 2, Offer, Hired, Rejected, On hold.
- **Dashboard** — pass rate, average scores, pipeline by stage, average score per
  competency, and interviewer activity.
- **Activity feed** — who added or changed which candidate, newest first.
- **Import / export** — JSON, and the importer accepts records exported from the old
  single-round tracker.

Scoring: each competency is rated 1 to 5 and scaled by its weight, so the round totals 100.
85+ Strong Hire, 75+ Hire, 65+ Borderline, below 65 Reject.

## Running it

```
npm install
APP_PASSCODE=your-passcode npm start
```

Then open http://localhost:3000.

## Environment variables

| Var | Required | What it does |
|---|---|---|
| `APP_PASSCODE` | Strongly recommended | Shared passcode. Without it the app is open to anyone with the URL, and candidate records hold names, emails and phone numbers. |
| `DATABASE_URL` | On Railway | Postgres connection string. Railway injects this when a Postgres service is linked. |
| `PORT` | No | Railway sets this. Defaults to 3000. |
| `DATA_DIR` | No | Where the JSON fallback store lives when there is no `DATABASE_URL`. Defaults to `./data`. |
| `DATABASE_SSL` | No | Set to `true` to force TLS on the Postgres connection (needed only for external/proxy connection strings). |

Without `DATABASE_URL` the app falls back to a JSON file so it still runs locally. On
Railway always attach Postgres: container filesystems are wiped on every deploy.

## Deploying to Railway

1. Railway dashboard, **New Project**, **Deploy from GitHub repo**, pick `sales_hiring`.
2. In the same project, **New**, **Database**, **Add PostgreSQL**.
3. Open the app service, **Variables**, and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (use the variable reference picker so it
     stays correct if the database is recreated)
   - `APP_PASSCODE` = the passcode you give the hiring team
4. **Settings**, **Networking**, **Generate Domain**. That URL is what you share.
5. Check `/api/health`. It should report `"storage":"postgres"`, `"storageReady":true` and
   `"passcodeRequired":true`.

Tables are created automatically on first boot. No migration step.

## API

All routes below `/api` require the `x-passcode` header when `APP_PASSCODE` is set.

| Route | What it does |
|---|---|
| `GET /api/health` | Storage kind, readiness, whether a passcode is required, build info. No passcode needed. |
| `POST /api/login` | Body `{passcode}`. Validates the passcode. No passcode header needed. |
| `GET /api/candidates` | All candidates, newest update first. |
| `POST /api/candidates` | Create. |
| `PUT /api/candidates/:id` | Create or replace by id. |
| `DELETE /api/candidates/:id` | Delete. |
| `GET /api/events?limit=` | Activity feed, newest first, capped at 200. |
| `POST /api/import` | Body `{candidates: [...], by}`. Merges by id. |

## Candidate record shape

```json
{
  "id": "c_1234_abcd",
  "name": "Candidate Name",
  "position": "Sales Associate",
  "email": "", "phone": "", "source": "",
  "stage": "round2",
  "rounds": {
    "round1": {
      "date": "2026-09-10",
      "interviewer": "Abhishek",
      "overallNotes": "",
      "sections": { "communication": { "rating": "4", "notes": "" } }
    },
    "round2": { }
  },
  "createdAt": 1757000000000,
  "updatedAt": 1757000000000,
  "updatedBy": "Abhishek"
}
```

## Notes

- The passcode is a shared secret, not user accounts. It keeps a leaked link from being
  useful; it does not tell two interviewers apart. Attribution comes from the "You are"
  name box and the interviewer field on each round.
- The page refreshes itself every 45 seconds so a second interviewer's entry appears
  without a reload, except while a form is open.
- The activity table is pruned to the most recent 500 entries.
