import { MockPlanner, LLMPlanner, RouterPlanner } from "@openvger/planner";
import type { ModelCallFn, ModelCallResult } from "@openvger/planner";
import type { Planner } from "@openvger/schemas";

const PROVIDER_DEFAULTS: Record<string, string> = {
  claude: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
};

function resolveProvider(opts: { planner?: string }): string {
  return opts.planner ?? process.env.OPENVGER_PLANNER ?? "mock";
}

function resolveModel(provider: string, opts: { model?: string }): string {
  return opts.model ?? process.env.OPENVGER_MODEL ?? PROVIDER_DEFAULTS[provider] ?? "unknown";
}

function createClaudeCallFn(model: string): ModelCallFn {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for the claude planner.\n" +
      "Set it with: export ANTHROPIC_API_KEY=sk-ant-..."
    );
  }

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = response.content[0];
    if (!block || block.type !== "text") {
      throw new Error("Claude returned no text content");
    }
    return {
      text: block.text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        model,
      },
    };
  };
}

function createOpenAICallFn(model: string): ModelCallFn {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;

  if (!apiKey && !baseURL) {
    throw new Error(
      "OPENAI_API_KEY or OPENAI_BASE_URL environment variable is required for the openai planner.\n" +
      "Set it with: export OPENAI_API_KEY=sk-...\n" +
      "For local endpoints (Ollama, vLLM): export OPENAI_BASE_URL=http://localhost:11434/v1"
    );
  }

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: apiKey ?? "not-needed",
      ...(baseURL ? { baseURL } : {}),
    });
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned no content");
    }
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
  };
}

export function createPlanner(opts: { planner?: string; model?: string; agentic?: boolean }): Planner {
  const provider = resolveProvider(opts);
  const model = resolveModel(provider, opts);

  switch (provider) {
    case "mock":
      return new MockPlanner({ agentic: opts.agentic });
    case "claude":
      return new LLMPlanner(createClaudeCallFn(model), { agentic: opts.agentic });
    case "openai":
      return new LLMPlanner(createOpenAICallFn(model), { agentic: opts.agentic });
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
