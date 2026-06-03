"""
llm.py : the swappable 'brain' for the MSP intelligence engine.

Switch providers with two env vars. No call site changes required:

    LLM_PROVIDER = anthropic | openai | deepseek
    LLM_MODEL    = <provider-specific model id>

Every provider implements one method, generate_json(), which returns a parsed
dict. Extraction, synthesis, and scoring all call this and never import a vendor
SDK directly, so the rest of the codebase stays brain-agnostic. Add a provider
by writing one class with one method.

We deliberately use plain prompted JSON as the common denominator rather than
each vendor's native structured-output mode. Native modes differ, plain JSON
does not, so this is what keeps the swap clean.
"""

from __future__ import annotations

import json
import os
import re
from abc import ABC, abstractmethod
from typing import Any


class LLMError(Exception):
    pass


def _extract_json(text: str) -> dict[str, Any]:
    """Pull a JSON object out of a model response, tolerating fences or preamble."""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    return json.loads(text)


class LLMProvider(ABC):
    """One method to implement per vendor."""

    def __init__(self, model: str):
        self.model = model

    @abstractmethod
    def _raw(self, system: str, user: str, max_tokens: int, temperature: float) -> str:
        ...

    def generate_json(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int = 1500,
        temperature: float = 0.0,
        retries: int = 1,
    ) -> dict[str, Any]:
        prompt = user
        last_err: Exception | None = None
        for _ in range(retries + 1):
            text = self._raw(system, prompt, max_tokens, temperature)
            try:
                return _extract_json(text)
            except (json.JSONDecodeError, ValueError) as e:
                last_err = e
                prompt = (
                    user
                    + "\n\nYour previous reply was not valid JSON. Return ONLY a "
                    "single JSON object, with no markdown and no commentary."
                )
        raise LLMError(f"Could not parse JSON after {retries + 1} attempts: {last_err}")


class AnthropicProvider(LLMProvider):
    def __init__(self, model: str):
        super().__init__(model)
        from anthropic import Anthropic

        self.client = Anthropic()  # reads ANTHROPIC_API_KEY

    def _raw(self, system, user, max_tokens, temperature):
        # temperature is deprecated on claude-haiku-4-5 and later — omit it.
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")


class OpenAICompatibleProvider(LLMProvider):
    """Works for OpenAI and any OpenAI-compatible endpoint such as DeepSeek."""

    def __init__(self, model: str, base_url: str | None = None, api_key_env: str = "OPENAI_API_KEY"):
        super().__init__(model)
        from openai import OpenAI

        self.client = OpenAI(api_key=os.environ[api_key_env], base_url=base_url)

    def _raw(self, system, user, max_tokens, temperature):
        # response_format json_object requires the word "json" to appear in the
        # messages. The extraction prompt satisfies this.
        resp = self.client.chat.completions.create(
            model=self.model,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content or ""


# Defaults are a convenience only. Model ids change often, so set LLM_MODEL
# explicitly and confirm the current id in each provider's docs.
_DEFAULTS = {
    "anthropic": "claude-haiku-4-5-20251001",
    "openai": "gpt-4o-mini",
    "deepseek": "deepseek-chat",
}


def get_provider() -> LLMProvider:
    name = os.getenv("LLM_PROVIDER", "anthropic").lower()
    model = os.getenv("LLM_MODEL", _DEFAULTS.get(name, ""))
    if not model:
        raise LLMError(f"No model set for provider {name!r}. Set LLM_MODEL.")
    if name == "anthropic":
        return AnthropicProvider(model)
    if name == "openai":
        return OpenAICompatibleProvider(model)
    if name == "deepseek":
        return OpenAICompatibleProvider(
            model, base_url="https://api.deepseek.com", api_key_env="DEEPSEEK_API_KEY"
        )
    raise LLMError(f"Unknown LLM_PROVIDER: {name!r}")
