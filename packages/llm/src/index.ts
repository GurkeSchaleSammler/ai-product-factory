import OpenAI from "openai";
import { z, type ZodType } from "zod";

const llmConfigSchema = z.object({
  LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  LLM_MODEL: z.string().min(1),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(16_384).default(2_000),
  LLM_ESTIMATED_CALL_COST_CHF: z.coerce.number().positive().default(0.10),
});

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  estimatedCallCostChf: number;
}

export function readLlmConfig(environment: NodeJS.ProcessEnv = process.env): LlmConfig {
  const value = llmConfigSchema.parse(environment);
  return {
    apiKey: value.LLM_API_KEY,
    baseUrl: value.LLM_BASE_URL,
    model: value.LLM_MODEL,
    maxOutputTokens: value.LLM_MAX_OUTPUT_TOKENS,
    estimatedCallCostChf: value.LLM_ESTIMATED_CALL_COST_CHF,
  };
}

export class JsonLlm {
  readonly #client: OpenAI;
  readonly #config: LlmConfig;

  constructor(config: LlmConfig) {
    this.#config = config;
    this.#client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async generate<T>(system: string, input: unknown, schema: ZodType<T>): Promise<T> {
    const completion = await this.#client.chat.completions.create({
      model: this.#config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: { type: "json_object" },
      max_tokens: this.#config.maxOutputTokens,
    });
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("LLM returned no JSON content");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("LLM returned invalid JSON");
    }
    return schema.parse(parsed);
  }
}
