/**
 * Registry of hosted models that play through OpenRouter.
 *
 * Every entry carries the request settings that were measured to work for that
 * model (prompt-contract report §4c): which models accept `temperature`, which
 * reason by default and how that is switched off, and how many output tokens
 * are safe before the answer is truncated.
 */
export interface HostedModel {
  /** Brain slug used in `--brains`, recordings and URLs. */
  slug: string;
  /** Display name. */
  name: string;
  /** Vendor shown on the site. */
  provider: string;
  /** OpenRouter model id. */
  model: string;
  /** Chat models answer through /chat/completions, classifiers through /systemone. */
  kind: 'llm' | 'classifier';
  /** Sent as `temperature` when present. Some models reject or ignore it. */
  temperature?: number;
  /**
   * 'off' sends `reasoning: { enabled: false }` (the model reasons by default and
   * allows switching it off). 'none' or absent sends no `reasoning` field at all
   * (either the model never reasons, or reasoning is mandatory and the field is
   * rejected with HTTP 400).
   */
  reasoning?: 'off' | 'none';
  /** `max_tokens` for chat completions. Unused by classifiers (0). */
  maxTokens: number;
  /**
   * `false` falls back to `response_format: { type: 'json_object' }`. Absent or
   * `true` sends the strict json_schema with the candidate ids as an enum.
   */
  jsonSchema?: boolean;
  /** USD per million tokens, informational only. */
  pricing?: { in: number; out: number };
}

export const HOSTED_MODELS: readonly HostedModel[] = [
  {
    slug: 'jev',
    name: 'Jev 1.13',
    provider: 'TypeSafe',
    model: 'typesafe/jev-1.13',
    kind: 'classifier',
    maxTokens: 0,
  },
  {
    slug: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'OpenAI',
    model: 'openai/gpt-4o-mini',
    kind: 'llm',
    temperature: 0,
    maxTokens: 80,
    pricing: { in: 0.15, out: 0.6 },
  },
  {
    slug: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'OpenAI',
    model: 'openai/gpt-5.6-luna',
    kind: 'llm',
    // temperature is not in the model's supported parameters; it is not sent.
    reasoning: 'off',
    maxTokens: 80,
    pricing: { in: 0.2, out: 1.2 },
  },
  {
    slug: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    provider: 'Google',
    model: 'google/gemini-3.5-flash-lite',
    kind: 'llm',
    temperature: 0,
    // Reasoning is mandatory on this endpoint: `{ enabled: false }` is HTTP 400.
    reasoning: 'none',
    maxTokens: 400,
    pricing: { in: 0.3, out: 2.5 },
  },
  {
    slug: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    model: 'deepseek/deepseek-v4-flash',
    kind: 'llm',
    temperature: 0,
    reasoning: 'off',
    maxTokens: 80,
    pricing: { in: 0.036, out: 0.072 },
  },
  {
    slug: 'qwen3.7-flash',
    name: 'Qwen 3.7 Flash',
    provider: 'Alibaba',
    model: 'qwen/qwen3.7-flash',
    kind: 'llm',
    temperature: 0,
    reasoning: 'off',
    maxTokens: 80,
    pricing: { in: 0.03, out: 0.13 },
  },
  // z-ai/glm-5.3-flash was tried and left out: its reasoning cannot be switched
  // off, ignores its token cap, and consumed 2,000 output tokens without an
  // answer on a 1.8k-token question (21 s, finish_reason length).
  {
    slug: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    model: 'anthropic/claude-haiku-4.5',
    kind: 'llm',
    temperature: 0,
    maxTokens: 80,
    // json_object is ignored by this model (fenced JSON plus prose); the strict
    // schema is the only reliable path.
    jsonSchema: true,
    pricing: { in: 1, out: 5 },
  },
];

export function findHostedModel(slug: string): HostedModel | undefined {
  return HOSTED_MODELS.find(model => model.slug === slug);
}

export function isHostedSlug(slug: string): boolean {
  return findHostedModel(slug) !== undefined;
}
