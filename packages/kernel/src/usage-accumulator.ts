import type { UsageMetrics, ModelPricing } from "@karnevil9/schemas";

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
}

export class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private tokens = 0;
  private costUsd = 0;
  private calls = 0;
  private pricing?: ModelPricing;

  constructor(pricing?: ModelPricing) {
    this.pricing = pricing;
  }

  record(usage: UsageMetrics): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.tokens += usage.total_tokens;
    this.calls++;

    if (usage.cost_usd != null) {
      this.costUsd += usage.cost_usd;
    } else if (this.pricing) {
      this.costUsd +=
        (usage.input_tokens / 1000) * this.pricing.input_cost_per_1k_tokens +
        (usage.output_tokens / 1000) * this.pricing.output_cost_per_1k_tokens;
    }
  }

  getSummary(): UsageSummary {
    return {
      total_input_tokens: this.inputTokens,
      total_output_tokens: this.outputTokens,
      total_tokens: this.tokens,
      total_cost_usd: this.costUsd,
      call_count: this.calls,
    };
  }

  get totalTokens(): number {
    return this.tokens;
  }

  get totalCostUsd(): number {
    return this.costUsd;
  }

  restoreFrom(summary: UsageSummary): void {
    this.inputTokens = summary.total_input_tokens;
    this.outputTokens = summary.total_output_tokens;
    this.tokens = summary.total_tokens;
    this.costUsd = summary.total_cost_usd;
    this.calls = summary.call_count;
  }
}
