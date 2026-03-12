import { MockPlanner, LLMPlanner, RouterPlanner, IFPlanner, BeamPlanner, bfsPath } from "@karnevil9/planner";
import type { ModelCallFn, ModelCallResult, IFModelCallFn } from "@karnevil9/planner";
import type { Planner } from "@karnevil9/schemas";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

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
  "claude-code": "claude-code",
  codex: "codex-default",
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
  grok: "grok-4",
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
  type MessageClient = { messages: { create: (...args: any[]) => any } };
  let clientPromise: Promise<MessageClient> | null = null;

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    if (!clientPromise) {
      clientPromise = import("@anthropic-ai/sdk").then(
        ({ default: Anthropic }) => new Anthropic({ apiKey }) as unknown as MessageClient
      ).catch((err) => { clientPromise = null; throw err; });
    }
    const client = await clientPromise;
    return withRetry(async () => {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt +
        "\n\nCRITICAL RULE: When using the 'respond' tool, always include a 'mood' field that reflects " +
        "the emotional tone of your response. Choose from: happy, excited, sad, " +
        "empathetic, neutral, concerned, confused, anxious. Match the mood to how " +
        "you'd feel delivering the message \u2014 happy for good news, concerned for " +
        "warnings, neutral for facts, etc.",
        messages: [{ role: "user", content: userPrompt }],
        tools: [{
          name: "submit_plan",
          description: "Submit the execution plan as structured JSON. The plan MUST include a steps array.",
          input_schema: {
            type: "object" as const,
            required: ["plan_id", "schema_version", "goal", "steps"],
            properties: {
              plan_id: { type: "string" as const, description: "Unique plan identifier" },
              schema_version: { type: "string" as const, description: "Always '0.1'" },
              goal: { type: "string" as const, description: "What this plan achieves" },
              assumptions: { type: "array" as const, items: { type: "string" as const } },
              steps: {
                type: "array" as const,
                description: "Execution steps. Empty array [] means task is complete.",
                items: {
                  type: "object" as const,
                  required: ["step_id", "title", "tool_ref", "input", "success_criteria"],
                  properties: {
                    step_id: { type: "string" as const },
                    title: { type: "string" as const },
                    tool_ref: {
                      type: "object" as const,
                      required: ["name"],
                      properties: { name: { type: "string" as const } },
                    },
                    input: { type: "object" as const },
                    success_criteria: { type: "array" as const, items: { type: "string" as const } },
                    failure_policy: { type: "string" as const, enum: ["abort", "continue", "replan"] },
                    timeout_ms: { type: "number" as const },
                    max_retries: { type: "number" as const },
                  },
                },
              },
              artifacts: { type: "array" as const },
            },
          },
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

/**
 * Raw Claude call function for IFPlanner — returns plain text (no tool_use forcing).
 * IFPlanner calls the model directly and parses freeform text output.
 */
function createClaudeRawCallFn(model: string): IFModelCallFn {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for the IF planner.\n" +
      "Set it with: export ANTHROPIC_API_KEY=sk-ant-..."
    );
  }

  type IFMessageClient = { messages: { create: (...args: any[]) => any } };
  let clientPromise: Promise<IFMessageClient> | null = null;

  return async (systemPrompt: string, userPrompt: string) => {
    if (!clientPromise) {
      clientPromise = import("@anthropic-ai/sdk").then(
        ({ default: Anthropic }) => new Anthropic({ apiKey }) as unknown as IFMessageClient
      ).catch((err) => { clientPromise = null; throw err; });
    }
    const client = await clientPromise;
    return withRetry(async () => {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = response.content.find((b: any) => b.type === "text");
      if (!textBlock) {
        throw new Error("Claude returned no text content");
      }
      return {
        text: (textBlock as { text: string }).text,
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

function createGeminiCallFn(model: string): ModelCallFn {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY environment variable is required for the gemini planner.\n" +
      "Set it with: export GOOGLE_API_KEY=AI..."
    );
  }

  type GeminiClient = { models: { generateContent: (...args: any[]) => any } };
  let clientPromise: Promise<GeminiClient> | null = null;

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    if (!clientPromise) {
      clientPromise = import("@google/genai").then(({ GoogleGenAI }) => {
        const ai = new GoogleGenAI({ apiKey });
        return { models: ai.models };
      }).catch((err) => { clientPromise = null; throw err; });
    }
    const client = await clientPromise;
    return withRetry(async () => {
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error("Gemini returned no content");
      }
      const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const candidatesTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      return {
        text,
        usage: {
          input_tokens: promptTokens,
          output_tokens: candidatesTokens,
          total_tokens: promptTokens + candidatesTokens,
          model,
        },
      };
    });
  };
}

function createGrokCallFn(model: string): ModelCallFn {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "XAI_API_KEY environment variable is required for the grok planner.\n" +
      "Set it with: export XAI_API_KEY=xai-..."
    );
  }

  let clientPromise: Promise<InstanceType<typeof import("openai").default>> | null = null;

  return async (systemPrompt: string, userPrompt: string): Promise<ModelCallResult> => {
    if (!clientPromise) {
      clientPromise = import("openai").then(
        ({ default: OpenAI }) => new OpenAI({
          apiKey,
          baseURL: "https://api.x.ai/v1",
        })
      ).catch((err) => { clientPromise = null; throw err; });
    }
    const client = await clientPromise;
    return withRetry(async () => {
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("Grok returned no content");
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
    });
  };
}

/**
 * Codex planner — uses `codex exec` with the ChatGPT OAuth auth.
 * Wraps the planner prompt so Codex outputs pure JSON without running commands.
 * Reads ~/.codex/config.toml for the default model.
 */
function createCodexCallFn(model: string): ModelCallFn {
  const configPath = join(homedir(), ".codex", "config.toml");
  let cliVerified = false;

  function readConfigModel(): string {
    try {
      const raw = readFileSync(configPath, "utf8");
      const match = raw.match(/^model\s*=\s*"(.+)"/m);
      return match?.[1] ?? "gpt-4o";
    } catch {
      return "gpt-4o";
    }
  }

  return async (systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<ModelCallResult> => {
    if (!cliVerified) {
      await new Promise<void>((resolve, reject) => {
        const check = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        check.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        check.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            reject(new Error(
              "Codex CLI not found. Install it with: npm install -g @openai/codex\n" +
              "Then authenticate with: codex login"
            ));
          } else {
            reject(err);
          }
        });
        check.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Codex CLI check failed (exit ${code}): ${stderr.trim()}`));
          } else {
            resolve();
          }
        });
      });
      cliVerified = true;
    }

    const effectiveModel = model !== "codex-default" ? model : readConfigModel();

    return withRetry(async () => {
      // Wrap the planner prompt so Codex acts as a pure JSON generator.
      // Instruct codex to output JSON only (not execute tools itself).
      const wrappedPrompt =
        "You are a JSON planning engine. Your ONLY job is to read the instructions below " +
        "and output a single valid JSON object as your response. " +
        "Do NOT execute any shell commands yourself. Do NOT use any of YOUR OWN tools. " +
        "Simply output the JSON plan text directly as your response.\n" +
        "IMPORTANT: The JSON plan you output SHOULD reference tools from the SYSTEM INSTRUCTIONS " +
        "(like shell-exec, http-request, browser, etc.) — those are the tools the plan executor " +
        "will run. You are planning WHICH tools to use, not executing them yourself.\n" +
        "CRITICAL RULES — you MUST follow these:\n" +
        "1. When the user asks for real-time information (current time, date, weather, " +
        "live data, etc.), you MUST plan tool steps to fetch that data (e.g. shell-exec with " +
        "'date' command). NEVER guess or answer from static context alone when live data is needed.\n" +
        "2. When the user asks you to access, read, fetch, or interact with a URL, website, " +
        "web page, API, or online service, you MUST plan tool steps to do so (e.g. http-request " +
        "to fetch the URL, browser to visit the page, or shell-exec with curl). You DO have " +
        "access to these tools — never claim you cannot access the web.\n" +
        "3. Never tell the user you lack capabilities that the SYSTEM INSTRUCTIONS provide. " +
        "If a tool exists in the system instructions, assume it is available and plan to use it.\n" +
        "4. When using the 'respond' tool, always include a 'mood' field that reflects " +
        "the emotional tone of your response. Choose from: happy, excited, sad, " +
        "empathetic, neutral, concerned, confused, anxious. Match the mood to how " +
        "you'd feel delivering the message \u2014 happy for good news, concerned for " +
        "warnings, neutral for facts, etc.\n\n" +
        "=== SYSTEM INSTRUCTIONS ===\n" + systemPrompt +
        "\n\n=== TASK ===\n" + userPrompt;

      const args = [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        ...(effectiveModel ? ["-m", effectiveModel] : []),
        "-",
      ];

      return new Promise<ModelCallResult>((resolve, reject) => {
        let settled = false;
        const proc = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir() });
        let stdout = "";
        let stderr = "";

        const onAbort = () => {
          if (settled) return;
          settled = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          }, 5_000).unref();
          reject(new Error("Codex CLI process killed by abort signal"));
        };
        if (signal?.aborted) {
          proc.kill("SIGTERM");
          reject(new Error("Codex CLI process killed by abort signal"));
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });

        proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on("error", (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(`Failed to spawn codex CLI: ${err.message}`));
        });

        proc.on("close", (code) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);

          // Parse JSONL output to extract agent message and usage
          let text = "";
          let inputTokens = 0;
          let outputTokens = 0;
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item?.text) {
                text = event.item.text;
              }
              if (event.type === "turn.completed" && event.usage) {
                inputTokens = event.usage.input_tokens ?? 0;
                outputTokens = event.usage.output_tokens ?? 0;
              }
              if (event.type === "error") {
                const errMsg = typeof event.message === "string" ? event.message : JSON.stringify(event);
                if (errMsg.includes("not logged in") || errMsg.includes("Not logged in") || errMsg.includes("not authenticated")) {
                  reject(new Error("Codex CLI is not authenticated.\nRun: codex login"));
                  return;
                }
              }
              if (event.type === "turn.failed") {
                const errMsg = event.error?.message ?? "Unknown error";
                reject(new Error(`Codex CLI turn failed: ${errMsg}`));
                return;
              }
            } catch { /* skip non-JSON lines */ }
          }

          if (code !== 0 && !text) {
            const msg = stderr.trim() || stdout.trim();
            reject(new Error(`Codex CLI failed (exit ${code}): ${msg.slice(0, 500)}`));
            return;
          }

          if (!text) {
            reject(new Error(`Codex CLI returned no agent message. Output: ${stdout.slice(0, 500)}`));
            return;
          }

          resolve({
            text,
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              model: effectiveModel,
            },
          });
        });

        proc.stdin.write(wrappedPrompt);
        proc.stdin.end();
      });
    });
  };
}

function createClaudeCodeCallFn(model: string): ModelCallFn {
  let cliVerified = false;

  return async (systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<ModelCallResult> => {
    // Lazy CLI verification on first call
    if (!cliVerified) {
      await new Promise<void>((resolve, reject) => {
        const check = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        check.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        check.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            reject(new Error(
              "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n" +
              "Then authenticate with: claude login"
            ));
          } else {
            reject(err);
          }
        });
        check.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Claude CLI check failed (exit ${code}): ${stderr.trim()}`));
          } else {
            resolve();
          }
        });
      });
      cliVerified = true;
    }

    return withRetry(async () => {
      const args = [
        "-p",
        "--output-format", "json",
        "--max-turns", "1",
        "--tools", "",
        "--model", model === "claude-code" ? "sonnet" : model,
        "--system-prompt", systemPrompt,
      ];

      return new Promise<ModelCallResult>((resolve, reject) => {
        let settled = false;
        // Strip CLAUDECODE env var to avoid "nested session" rejection while
        // preserving all other env (including auth config paths).
        const childEnv = { ...process.env };
        delete childEnv.CLAUDECODE;
        delete childEnv.CLAUDE_CODE_ENTRYPOINT;
        const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
        let stdout = "";
        let stderr = "";

        // Kill the child process when the planner signals abort (e.g. timeout).
        // Without this, timed-out CLI processes live forever as zombies.
        const onAbort = () => {
          if (settled) return;
          settled = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          }, 5_000).unref();
          reject(new Error("Claude Code CLI process killed by abort signal"));
        };
        if (signal?.aborted) {
          proc.kill("SIGTERM");
          reject(new Error("Claude Code CLI process killed by abort signal"));
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });

        proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on("error", (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
        });

        proc.on("close", (code) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);

          if (code !== 0) {
            const msg = stderr.trim() || stdout.trim();
            if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many requests")) {
              const err = new Error(`Claude Code CLI rate limited: ${msg}`);
              (err as unknown as Record<string, unknown>).status = 429;
              reject(err);
              return;
            }
            if (msg.includes("not authenticated") || msg.includes("not logged in")) {
              reject(new Error(
                "Claude Code CLI is not authenticated.\n" +
                "Run: claude login"
              ));
              return;
            }
            reject(new Error(`Claude Code CLI failed (exit ${code}): ${msg}`));
            return;
          }

          try {
            const parsed = JSON.parse(stdout);
            // CLI v2+ outputs a JSON array of events; find the "result" event.
            // Older versions output a single envelope object.
            let envelope: Record<string, unknown>;
            if (Array.isArray(parsed)) {
              const resultEvent = parsed.find((e: Record<string, unknown>) => e.type === "result");
              if (!resultEvent) {
                reject(new Error(`Claude Code CLI returned no result event. Events: ${parsed.map((e: Record<string, unknown>) => e.type).join(", ")}`));
                return;
              }
              envelope = resultEvent;
            } else {
              envelope = parsed;
            }
            if (envelope.result == null) {
              reject(new Error(`Claude Code CLI returned no result (subtype: ${envelope.subtype ?? "unknown"}, is_error: ${envelope.is_error}). Output: ${stdout.slice(0, 500)}`));
              return;
            }
            if (envelope.is_error) {
              reject(new Error(`Claude Code CLI error: ${envelope.result}`));
              return;
            }
            const text = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result);
            const usage = envelope.usage as Record<string, number> | undefined;
            resolve({
              text,
              usage: {
                input_tokens: usage?.input_tokens ?? 0,
                output_tokens: usage?.output_tokens ?? 0,
                total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
                model: model === "claude-code" ? "claude-code" : model,
                cost_usd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd as number : undefined,
              },
            });
          } catch {
            reject(new Error(`Failed to parse Claude Code CLI output: ${stdout.slice(0, 200)}`));
          }
        });

        // Pipe user prompt via stdin to avoid ARG_MAX issues
        proc.stdin.write(userPrompt);
        proc.stdin.end();
      });
    });
  };
}

export function createPlanner(opts: { planner?: string; model?: string; agentic?: boolean; baseURL?: string; beam?: boolean }): Planner {
  const provider = resolveProvider(opts);
  const model = resolveModel(provider, opts);

  let planner: Planner;
  switch (provider) {
    case "mock":
      planner = new MockPlanner({ agentic: opts.agentic });
      break;
    case "claude":
      planner = new LLMPlanner(createClaudeCallFn(model), { agentic: opts.agentic });
      break;
    case "claude-code":
      planner = new LLMPlanner(createClaudeCodeCallFn(model), { agentic: opts.agentic });
      break;
    case "codex":
      planner = new LLMPlanner(createCodexCallFn(model), { agentic: opts.agentic });
      break;
    case "openai":
      planner = new LLMPlanner(createOpenAICallFn(model, opts.baseURL), { agentic: opts.agentic });
      break;
    case "gemini":
      planner = new LLMPlanner(createGeminiCallFn(model), { agentic: opts.agentic });
      break;
    case "grok":
      planner = new LLMPlanner(createGrokCallFn(model), { agentic: opts.agentic });
      break;
    case "router": {
      const underlying = new LLMPlanner(createClaudeCallFn(model), { agentic: opts.agentic });
      planner = new RouterPlanner({ delegate: underlying });
      break;
    }
    case "if": {
      const ifCallModel: IFModelCallFn = createClaudeRawCallFn(model);
      planner = new IFPlanner({ callModel: ifCallModel, bfsPathFinder: bfsPath });
      break;
    }
    default:
      throw new Error(
        `Unknown planner type: "${provider}". Valid options: mock, claude, claude-code, codex, openai, gemini, grok, router, if`
      );
  }

  // Wrap in BeamPlanner if enabled
  if (opts.beam ?? !!process.env.KARNEVIL9_BEAM) {
    const threshold = (process.env.KARNEVIL9_BEAM_THRESHOLD === "moderate" ? "moderate" : "complex") as "moderate" | "complex";
    return new BeamPlanner({ delegate: planner, beamThreshold: threshold });
  }
  return planner;
}
