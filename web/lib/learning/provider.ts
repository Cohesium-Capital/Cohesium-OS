import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// The swappable brain for the learning analyzer.
//
// Same idea as llm.py at the repo root: one method, two env vars, no vendor
// name baked into the call site. The analyzer asks for JSON matching a schema
// and does not care who produced it.
//
//   LEARNING_MODEL    provider/model, e.g. anthropic/claude-opus-5,
//                     openai/gpt-5, deepseek/deepseek-chat
//   LEARNING_API_KEY  the key for whichever provider that is
//   LEARNING_BASE_URL optional; point an OpenAI-compatible provider somewhere
//                     else (OpenRouter, Groq, Together, a local server)
//
// Two adapters cover nearly everything: Anthropic's Messages API, and the
// OpenAI chat-completions shape that most other providers implement. Anthropic
// goes through its official SDK; the OpenAI-compatible path is a plain fetch,
// which is what that shape is — adding a second vendor SDK would buy nothing
// and, on this repo, costs a lockfile repair.
//
// Structured output uses each provider's native JSON-schema mode where it
// exists, and falls back to asking for bare JSON. The caller validates with zod
// either way, so a provider with no schema mode still works — just with the
// validation doing more of the work.

export type LlmRequest = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
};

export type LlmResponse = {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The provider declined the request outright, rather than failing. */
  refused: boolean;
};

export type ProviderConfig = {
  provider: "anthropic" | "openai-compatible";
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** What to tell the operator when it is not configured. */
  label: string;
};

/** Default when nothing is set: the model this analyzer was written against. */
const DEFAULT_MODEL = "anthropic/claude-opus-5";

// Providers that speak the OpenAI chat-completions shape, with their default
// endpoints. Anything else works too — set LEARNING_BASE_URL.
const OPENAI_COMPATIBLE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * Resolve configuration from the environment. Returns null when no key is
 * available, which the analyzer treats as "collect but don't analyze" rather
 * than as an error.
 */
export function resolveProvider(): ProviderConfig | null {
  const spec = (process.env.LEARNING_MODEL ?? DEFAULT_MODEL).trim();
  const [rawProvider, ...rest] = spec.includes("/") ? spec.split("/") : ["anthropic", spec];
  const provider = rawProvider.toLowerCase();
  const model = rest.join("/") || spec;

  // The generic key wins; the vendor-specific ones are honoured so an existing
  // ANTHROPIC_API_KEY or OPENAI_API_KEY keeps working untouched.
  const apiKey =
    process.env.LEARNING_API_KEY ||
    (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : "") ||
    (provider === "openai" ? process.env.OPENAI_API_KEY : "") ||
    "";
  if (!apiKey) return null;

  const baseUrl = process.env.LEARNING_BASE_URL || OPENAI_COMPATIBLE[provider];

  if (provider === "anthropic") {
    return { provider: "anthropic", model, apiKey, label: `anthropic/${model}` };
  }
  if (!baseUrl) {
    // An unknown provider with no base URL cannot be called. Say so plainly
    // rather than guessing an endpoint.
    return null;
  }
  return {
    provider: "openai-compatible",
    model,
    apiKey,
    baseUrl,
    label: `${provider}/${model}`,
  };
}

/** Which env var the operator should set, for the Settings message. */
export function providerHint(): string {
  const spec = (process.env.LEARNING_MODEL ?? DEFAULT_MODEL).trim();
  const provider = spec.includes("/") ? spec.split("/")[0] : "anthropic";
  const known = provider === "anthropic" || provider in OPENAI_COMPATIBLE;
  return known
    ? `LEARNING_API_KEY is not set (LEARNING_MODEL is "${spec}")`
    : `LEARNING_MODEL is "${spec}", which is not a known provider — set LEARNING_BASE_URL to its OpenAI-compatible endpoint`;
}

export async function callModel(
  cfg: ProviderConfig,
  req: LlmRequest,
): Promise<LlmResponse> {
  return cfg.provider === "anthropic" ? callAnthropic(cfg, req) : callOpenAiCompatible(cfg, req);
}

async function callAnthropic(cfg: ProviderConfig, req: LlmRequest): Promise<LlmResponse> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: req.maxTokens,
    system: req.system,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: req.schema },
    },
    messages: [{ role: "user", content: req.user }],
  });

  // A refusal is a successful HTTP response with no usable content — it has to
  // be checked before reading content, or parsing fails confusingly.
  if (response.stop_reason === "refusal") {
    return { text: "", model: cfg.model, inputTokens: null, outputTokens: null, refused: true };
  }

  return {
    text: response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(""),
    model: cfg.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    refused: false,
  };
}

type ChatCompletion = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

async function callOpenAiCompatible(
  cfg: ProviderConfig,
  req: LlmRequest,
): Promise<LlmResponse> {
  const body = (structured: boolean) => ({
    model: cfg.model,
    max_completion_tokens: req.maxTokens,
    messages: [
      { role: "system", content: req.system },
      {
        role: "user",
        // Without a schema mode, the shape has to be carried in the prompt.
        content: structured
          ? req.user
          : `${req.user}\n\nReturn ONLY a JSON object matching this schema, with no prose and no code fences:\n${JSON.stringify(req.schema)}`,
      },
    ],
    ...(structured
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: req.schemaName, schema: req.schema, strict: true },
          },
        }
      : {}),
  });

  const send = async (structured: boolean) =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body(structured)),
    });

  let res = await send(true);
  // Providers that advertise the OpenAI shape do not all implement its schema
  // mode. Rather than maintaining a capability table that goes stale, try the
  // strict form and fall back once on a 400.
  if (res.status === 400) {
    res = await send(false);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${cfg.label} returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }

  const json = (await res.json()) as ChatCompletion;
  if (json.error?.message) throw new Error(`${cfg.label}: ${json.error.message}`);

  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    model: cfg.model,
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null,
    refused: choice?.finish_reason === "content_filter",
  };
}
