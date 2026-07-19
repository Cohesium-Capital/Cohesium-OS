# Clay enrichment — setup and operation

Clay is the enrichment layer: it takes contacts we sourced (name, title,
company) and fills in what outreach needs (email, phone, LinkedIn). The app
treats Clay as a commodity service — contacts flow out, enriched rows flow
back, and the app's database remains the system of record.

The loop has three legs:

```
App (Review page)  ──export/push──▶  Clay table  ──enrichment waterfall──▶
Clay HTTP write-back  ──POST──▶  App /api/enrichment  ──▶  contact updated
```

## One-time setup

### 1. Environment variables (app side)

Both live in `web/.env.local` locally and in the Vercel project settings for
production:

| Variable | Purpose |
|----------|---------|
| `CLAY_TABLE_WEBHOOK_URL` | The webhook-source URL of your Clay table. Required for the "Push pending to Clay" button; the CSV export works without it. |
| `ENRICHMENT_WEBHOOK_SECRET` | Shared secret Clay must send back with enriched rows. Required for the write-back to be accepted. Pick any long random string. |

### 2. Create the Clay table

1. In Clay, create a table whose columns match the app's export exactly:
   `contact_id`, `full_name`, `title`, `persona`, `company_name`,
   `company_domain`, `linkedin_url`.
2. Add a **Webhook** source to the table (Clay: *Add source → Monitor webhook*).
   Copy the webhook URL it gives you into `CLAY_TABLE_WEBHOOK_URL`.
3. **Set the table to dedupe on `contact_id`.** The app may push the same
   pending contact more than once (rows stay "pending" until the write-back
   lands); deduping prevents duplicate enrichment spend.

### 3. Build the enrichment waterfall

Add Clay enrichment columns as you see fit (work email waterfall, phone,
LinkedIn lookup). The app doesn't care how Clay finds the data — only what
comes back.

### 4. Configure the write-back

Add an **HTTP API** enrichment column (Clay: *Add enrichment → HTTP API*) as
the final step of the table:

- **Method / URL:** `POST https://<your-app-domain>/api/enrichment`
  (for local dev: `http://localhost:3000/api/enrichment`, reachable only if
  Clay can see your machine — in practice test the endpoint with `curl`).
- **Headers:**
  - `Authorization: Bearer <ENRICHMENT_WEBHOOK_SECRET>`
  - `Content-Type: application/json`
- **Body:** map Clay columns into this shape (only `contact_id` is required):

```json
{
  "contact_id": "{{contact_id}}",
  "email": "{{work_email}}",
  "phone": "{{phone}}",
  "linkedin_url": "{{linkedin_url}}",
  "personalization": "{{personalization}}",
  "status": "enriched"
}
```

The endpoint also accepts an array of rows, or `{ "rows": [...] }`, in one
request.

Write-back behavior (see `web/app/api/enrichment/route.ts`):

- Empty/whitespace values are ignored, so Clay misses don't blank out
  existing data.
- If `status` is omitted, the app infers it: `enriched` when an email or
  LinkedIn URL came back, `failed` otherwise.
- On `enriched`, the contact's `stage` also advances to `enriched`.
- The response is `{ "updated": <n>, "errors": [...] }` — an unknown
  `contact_id` shows up in `errors`, which usually means the body mapping is
  wrong.

## Day-to-day operation

Everything happens from the **Review** page (step 2 in the sidebar).

1. Sourced contacts start with `enrichment_status = 'pending'`.
2. Send the pending set to Clay, either way:
   - **Export pending for Clay** — downloads `pending-enrichment.csv`; import
     it into the Clay table manually. Works with zero webhook setup.
   - **Push pending to Clay** — sends every pending contact straight to the
     table webhook. Handles Clay's rate limits (bounded concurrency,
     retry/backoff honoring `Retry-After`) and reports
     `Pushed N / failed M (reason)`.
3. Clay enriches and each finished row POSTs back to `/api/enrichment`.
4. The contact fills in and its status flips to `enriched` (or `failed`).
   The Review grid reflects the new status; contacts with an email or
   LinkedIn URL become draftable in step 4 once their batch passes the gate.

Neither the export nor the push changes `enrichment_status` — rows stay
`pending` until the write-back lands. So "pending" always means "Clay hasn't
answered yet", and re-running the export/push simply retries the stragglers
(the dedupe key makes this safe).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| "CLAY_TABLE_WEBHOOK_URL is not set" toast | Env var missing in `web/.env.local` / Vercel. |
| Push reports many failures with `HTTP 429` | Clay rate-limiting a big burst; re-run the push — retries + dedupe make it idempotent. |
| Write-back returns 401 | `Authorization` header doesn't match `ENRICHMENT_WEBHOOK_SECRET`. |
| Write-back errors `no matching contact` | The `contact_id` body mapping in Clay's HTTP column is wrong (must echo the `contact_id` column verbatim). |
| Contacts stuck on "pending" forever | Write-back step missing/failing in Clay — check the HTTP column's run history. |
