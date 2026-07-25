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
| `ENRICHMENT_WEBHOOK_SECRET` | Shared secret Clay must send back with enriched rows. **Optional for now:** when unset, `/api/enrichment` accepts write-backs with no token (local/dev). When set, Clay must send `Authorization: Bearer <secret>` (or `x-webhook-secret`). |

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
  - `Content-Type: application/json`
  - Optional (only if `ENRICHMENT_WEBHOOK_SECRET` is set on the app):
    `Authorization: Bearer <ENRICHMENT_WEBHOOK_SECRET>`
    (or `x-webhook-secret: <secret>`)
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
- **Status codes:** `200` when at least one row updated (or nothing was sent);
  `422` when rows were sent but *none* matched — so a broken `contact_id`
  mapping shows up as a red/errored cell in Clay instead of a green 200.
  Don't trust the status code alone on batches: a `200` can still carry
  per-row `errors`.

## Day-to-day operation

Everything happens from **Review & Enrich** (step 2 in the sidebar) — part
**B** on that page, after you've vetted contacts in part **A**. Clay's main
job is filling **work email** (plus phone / LinkedIn when available).

1. Sourced contacts start with `enrichment_status = 'pending'`.
2. Send the eligible set to Clay, either way:
   - **Export CSV for Clay** — downloads `pending-enrichment.csv`; import
     it into the Clay table manually. Works with zero webhook setup.
   - **Push pending to Clay** — sends every eligible contact straight to the
     table webhook. Handles Clay's rate limits (bounded concurrency,
     retry/backoff honoring `Retry-After`) and reports
     `Pushed N / failed M (reason)`.
3. Clay enriches and each finished row POSTs back to `/api/enrichment`.
4. The contact fills in and its status flips to `enriched` (or `failed`).
   The Review & Enrich counts update; contacts with an email or LinkedIn URL
   become draftable in step 4 once their batch passes the Grade gate.

### One contact is only ever sent once

Neither path changes `enrichment_status` — rows stay `pending` until the
write-back lands, so "pending" always means "Clay hasn't answered yet".

Both paths **do** stamp `contacts.clay_pushed_at`, and eligibility requires it
to be `NULL`. That is the double-spend guard. Without it, any contact Clay
never wrote back on (no email found, a failed run, a misconfigured HTTP column)
stayed `pending` forever and was re-sent — and re-billed — by every subsequent
push. Clay's table dedupe key stops duplicate *rows*; it does not stop the
enrichment columns from running again.

Because downloading the CSV is itself a send, the export marks its rows too and
records the same `pushed` event in `enrichment_events`. Download it only when
you mean to load it.

To send a contact through Clay a second time — the first send genuinely didn't
land, the Clay table was wiped — use **Re-send N already sent…** on Review &
Enrich, which arms and then confirms. It spends credits again, which is why it
is never implied by "push all eligible". The Review page shows the held-back
count as *"already sent (no write-back yet)"* so this set is visible rather
than silently missing from the eligible count.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| "CLAY_TABLE_WEBHOOK_URL is not set" toast | Env var missing in `web/.env.local` / Vercel. |
| Push reports many failures with `HTTP 429` | Clay rate-limiting a big burst. Only rows Clay accepted are marked as sent, so the failures stay eligible — just re-run the push. |
| "Nothing new to send" but contacts are still `pending` | They've already been through Clay and are waiting on a write-back (see the *already sent* count). Fix the write-back rather than re-sending; **Re-send** only if the first send truly didn't land. |
| Write-back returns 401 | `ENRICHMENT_WEBHOOK_SECRET` is set on the app but Clay’s `Authorization` / `x-webhook-secret` header doesn’t match (or is missing). Unset the secret locally to skip auth for now. |
| Write-back errors `no matching contact` | The `contact_id` body mapping in Clay's HTTP column is wrong (must echo the `contact_id` column verbatim). |
| Contacts stuck on "pending" forever | Write-back step missing/failing in Clay — check the HTTP column's run history. |
