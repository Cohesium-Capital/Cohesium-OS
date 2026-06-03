"""
extract.py : turn one raw interaction into structured, validated insight.

Brain-agnostic. It only talks to llm.get_provider(), so swapping providers is
an env change, never a code change.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

load_dotenv()  # populate env from .env before llm.py / supabase read it

from llm import get_provider

PROMPT_VERSION = "v1"
_PROMPT = (
    Path(__file__).parent / "prompts" / f"conversation_extraction_{PROMPT_VERSION}.md"
).read_text()


class ConversationExtraction(BaseModel):
    """The output contract. Provider-independent. Mirrors the extractions table."""

    current_msp: Optional[str] = None
    satisfaction: Literal["positive", "neutral", "negative", "unknown"] = "unknown"
    switching_intent: Literal["none", "passive", "active", "unknown"] = "unknown"
    owner_referenced: bool = False
    tech_stack: list[str] = Field(default_factory=list)
    pain_points: list[str] = Field(default_factory=list)
    summary: str = ""
    extra: dict = Field(default_factory=dict)


def extract_interaction(
    channel: str, content: str, *, contact_hint: str = ""
) -> tuple[ConversationExtraction, str]:
    """Returns the validated extraction and the model id that produced it."""
    provider = get_provider()
    user = (
        f"CHANNEL: {channel}\n"
        f"CONTACT CONTEXT: {contact_hint or 'none'}\n\n"
        f"RAW CONTENT:\n{content}"
    )
    data = provider.generate_json(system=_PROMPT, user=user)
    try:
        result = ConversationExtraction(**data)
    except ValidationError as e:
        # Never drop the payload. Flag it for review and keep the raw output.
        result = ConversationExtraction(
            summary="VALIDATION_FAILED",
            extra={"raw": data, "errors": e.errors()},
        )
    return result, provider.model


# --- persistence -----------------------------------------------------------
_sb_client = None


def _supabase():
    """Lazy singleton. Uses the service_role key so RLS is bypassed."""
    global _sb_client
    if _sb_client is None:
        from supabase import create_client

        _sb_client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
    return _sb_client


def save_extraction(interaction_id: str, result: ConversationExtraction, model_name: str) -> str:
    """Insert one extraction row. Returns the new row id."""
    payload = result.model_dump()
    payload.update(
        interaction_id=interaction_id,
        model_name=model_name,
        prompt_version=PROMPT_VERSION,
    )
    resp = _supabase().table("extractions").insert(payload).execute()
    return resp.data[0]["id"]


if __name__ == "__main__":
    sample = (
        "Thanks for reaching out. We've been with TechCare for about three years. "
        "Honestly the response times have gotten slow lately and we're starting to "
        "look around. We run mostly Microsoft 365 and a couple of legacy servers."
    )
    extraction, model = extract_interaction("email", sample, contact_hint="Head of IT, 40-person law firm")
    print(f"model: {model}")
    print(extraction.model_dump_json(indent=2))

    if os.getenv("SUPABASE_URL"):
        sb = _supabase()
        org = sb.table("organizations").upsert(
            {"name": "Sample Law Firm", "domain": "sample-law.example", "kind": "customer"},
            on_conflict="domain",
        ).execute().data[0]
        contact = sb.table("contacts").insert(
            {"organization_id": org["id"], "full_name": "Sample Contact", "persona": "head_of_it"}
        ).execute().data[0]
        interaction = sb.table("interactions").insert(
            {"contact_id": contact["id"], "channel": "email", "raw_content": sample}
        ).execute().data[0]
        extraction_id = save_extraction(interaction["id"], extraction, model)
        print(f"saved extraction {extraction_id} for interaction {interaction['id']}")
