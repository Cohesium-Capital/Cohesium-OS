# MSP Intelligence Engine (starter)

A thin, brain-agnostic core for the MSP customer-intelligence and acquisition
engine. The principle: own the data and the synthesis, rent the commodity parts
(enrichment, sending). The moat is the structured dataset and the insight system
on top of it, not the application around it.

## Files

- `schema.sql` : Postgres / Supabase tables for both flows. Run once against your DB.
- `prompts/conversation_extraction_v1.md` : the versioned extraction prompt.
- `llm.py` : the swappable brain. One interface, multiple providers.
- `extract.py` : turns one raw interaction into a validated `ConversationExtraction`.

## Quick start

```
pip install anthropic openai pydantic
export LLM_PROVIDER=anthropic
export LLM_MODEL=claude-haiku-4-5-20251001
export ANTHROPIC_API_KEY=...
python extract.py        # runs the built-in sample
```

## Swapping the brain

No call sites change. Set two env vars:

```
export LLM_PROVIDER=deepseek
export LLM_MODEL=deepseek-chat
export DEEPSEEK_API_KEY=...
```

Add a new provider by writing one class with one `_raw` method in `llm.py`.
Everything downstream stays untouched because it only ever calls
`get_provider().generate_json(...)`.

Model ids change often. Set `LLM_MODEL` explicitly and confirm the current id in
each provider's docs rather than trusting the defaults baked into `llm.py`.

## Cost note

Automated calls from this app bill at API rates regardless of provider. Your
Claude Max subscription covers interactive Claude Code only. So use Claude Code
on Max for the heavy research you trigger yourself, and keep these automated
extraction and synthesis calls on a cheap model (Haiku, gpt-4o-mini,
deepseek-chat). They are short, so the bill stays small. Swappability is also a
cost lever: you can route high-frequency extraction to the cheapest provider
without touching code.

## Re-extraction (forward compatibility)

`interactions.raw_content` is kept forever. When you want a new field, bump
`PROMPT_VERSION`, update the prompt and the `ConversationExtraction` model, then
re-run extraction across the archive. Old conversations populate the new field,
so you never lose an insight you did not anticipate at the start.

## What to build next

Resist building a full custom CRM before the data earns it. Stand this up, start
collecting structured conversations now, and harden it into a real application
later if volume justifies it. The enrichment and sending layers stay as
best-of-breed services (Clay, HeyReach, a print-and-mail API) that write into
this datastore. Demote them from system of record to commodity services your
data layer calls.
