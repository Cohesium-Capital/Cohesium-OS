/**
 * How an agent-mode run returns its output without a human moving JSON.
 *
 * Appended to the prompt AFTER createRun, because it needs the run's id — which
 * does not exist when renderPrompt builds the brief, and must never live in the
 * template anyway: a per-run value inside a hashed template would fork
 * prompt_versions on every single run. It is transport, not brief, which is also
 * why the stored `rendered_prompt` keeps the brief without it.
 *
 * Single mode gets nothing appended: a chat window cannot make the request.
 *
 * Lives outside actions.ts because that file is "use server", where every export
 * must be an async server action — a plain string builder cannot be exported
 * from it, and therefore could not be tested.
 */
export function deliveryFooter(runId: string, origin: string): string {
  return `

---

Return the result by POSTing it, rather than printing it for a human to copy:

  curl -sS -X POST "${origin}/api/runs/${runId}/ingest" \\
    -H "Authorization: Bearer $COHESIUM_API_TOKEN" \\
    -H "Content-Type: application/json" \\
    --data-binary @result.json

Write the merged JSON to result.json first — piping a large body inline is where
shells mangle quotes. The token needs the "ingest" scope; if this returns 403,
create a new token under Settings → API tokens (scopes are fixed at mint, so an
older token cannot be granted it).

200 means the rows landed. 422 means NOTHING was imported: read "error" and
"messages", fix the payload, and post again. A run accepts one successful
ingest, so if it reports already ingested, start a new run rather than retrying.
Never report success on a 422.`;
}
