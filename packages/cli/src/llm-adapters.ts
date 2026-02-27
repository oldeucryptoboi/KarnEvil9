import { MockPlanner, LLMPlanner, RouterPlanner } from "@karnevil9/planner";
import type { ModelCallFn, ModelCallResult } from "@karnevil9/planner";
import type { Planner } from "@karnevil9/schemas";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Network errors
  if (msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("etimedout") || msg.includes("fetch failed") || msg.includes("socket hang up")) return true;
  // HTTP 5xx or 429 from SDK errors
  if ("status" in err && typeof (err as Record<string, unknown>).status === "number") {
    const status = (err as Record<string, unknown>).status as number;
    if (status === 429 || status >= 500) return true;
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

function resolveProvider(opts: { planner?: string }): string {
  return opts.planner ?? process.env.KARNEVIL9_PLANNER ?? (process.env.ANTHROPIC_API_KEY ? "claude" : "mock");
}

function resolveModel(provider: string, opts: { model?: string }): string {
  return opts.model ?? process.env.KARNEVIL9_MODEL ?? PROVIDER_DEFAULTS[provider] ?? "unknown";
}

function createClaudeCallFn(model: string): ModelCallFn {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for the claude planner.\n" +
      "Set it with: export ANTHROPIC_API_KEY=sk-ant-..."
    );
  }

  // Cache client across calls for HTTP connection pooling; clear on failure so next call retries
  let clientPromise: Promise<{ messages: { create: Function } }> | null = null;

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    if (!clientPromise) {
      clientPromise = import("@anthropic-ai/sdk").then(
        ({ default: Anthropic }) => new Anthropic({ apiKey }) as unknown as { messages: { create: Function } }
      ).catch((err) => { clientPromise = null; throw err; });
    }
    const client = await clientPromise;
    return withRetry(async () => {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [{
          name: "submit_plan",
          description: "Submit the execution plan as structured JSON",
          input_schema: { type: "object" as const },
        }],
        tool_choice: { type: "tool" as const, name: "submit_plan" },
      });
      const block = response.content.find((b: any) => b.type === "tool_use");
      if (!block) {
        throw new Error("Claude returned no tool call");
      }
      return {
        text: JSON.stringify(block.input),
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens,
          model,
        },
      };
    });
  };
}

function createOpenAICallFn(model: string, overrideBaseURL?: string): ModelCallFn {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = overrideBaseURL ?? process.env.OPENAI_BASE_URL;

  if (!apiKey && !baseURL) {
    throw new Error(
      "OPENAI_API_KEY or OPENAI_BASE_URL environment variable is required for the openai planner.\n" +
      "Set it with: export OPENAI_API_KEY=sk-...\n" +
      "For local endpoints (Ollama, vLLM): export OPENAI_BASE_URL=http://localhost:11434/v1"
    );
  }

  // Cache client across calls for HTTP connection pooling; clear on failure so next call retries
  let clientPromise: Promise<InstanceType<typeof import("openai").default>> | null = null;

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    if (!clientPromise) {
      clientPromise = import("openai").then(
        ({ default: OpenAI }) => new OpenAI({
          apiKey: apiKey ?? "not-needed",
          ...(baseURL ? { baseURL } : {}),
        })
      ).catch((err) => { clientPromise = null; throw err; });
    }
    const client = await clientPromise;
    // Disable thinking for local models that support Qwen3-style /no_think
    const effectiveSystemPrompt = overrideBaseURL ? systemPrompt + " /no_think" : systemPrompt;
    return withRetry(async () => {
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: effectiveSystemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      let content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("OpenAI returned no content");
      }
      // Strip Qwen3-style <think>...</think> reasoning tags
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      return {
        text: content,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          model,
        },
      };
    });
  };
}

export function createPlanner(opts: { planner?: string; model?: string; agentic?: boolean; baseURL?: string }): Planner {
  const provider = resolveProvider(opts);
  const model = resolveModel(provider, opts);

  switch (provider) {
    case "mock":
      return new MockPlanner({ agentic: opts.agentic });
    case "claude":
      return new LLMPlanner(createClaudeCallFn(model), { agentic: opts.agentic });
    case "openai":
      return new LLMPlanner(createOpenAICallFn(model, opts.baseURL), { agentic: opts.agentic });
    case "router": {
      const underlying = new LLMPlanner(createClaudeCallFn(model), { agentic: opts.agentic });
      return new RouterPlanner({ delegate: underlying });
    }
    default:
      throw new Error(
        `Unknown planner type: "${provider}". Valid options: mock, claude, openai, router`
      );
  }
}
