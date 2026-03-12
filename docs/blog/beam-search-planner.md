# Beam Search for Agentic Planning: What Happens When You Give an AI Agent a Second Opinion

*March 12, 2026 · KarnEvil9 Engineering*

---

LLM planners produce a single trajectory. Even reasoning models — Claude with extended thinking, o1/o3, Gemini thinking — that internally explore multiple strategies still collapse to one output. The alternatives the model considered are invisible to the system: they can't be scored, they can't be evaluated against execution history, and there's no guarantee the model even considered a *structurally* different approach versus minor variations of the same idea.

It's like asking someone for directions. They might briefly consider the backroads, but they'll tell you "take the highway" — and you'll never know the backroads existed.

We fixed this by making the exploration explicit.

## The Inspiration: Probabilistic Dreaming

A paper caught our eye at ICLR 2026 — [Probabilistic Dreaming for World Models](https://arxiv.org/abs/2603.04715) by Gavin Wong (Yale). The core insight is deceptively simple: in reinforcement learning, maintaining just K=2 hypotheses about the world state gives a **4.5% improvement** and **28% lower variance** compared to a single trajectory. Why? Because a single Gaussian latent collapses mutually exclusive futures into a non-existent average — what Wong calls "averaging 'left' and 'right' paths into an impossible 'middle' path."

The agent literally freezes when faced with two valid strategies, because its single representation can't hold both.

The analogy to LLM planning isn't about whether the model *thinks* about alternatives — it does. It's about whether those alternatives are *surfaced, scored, and selected* using signals the model doesn't have: tool success rates from previous executions, structural quality heuristics, and runtime context. A reasoning model's internal deliberation is rich but opaque. Beam search makes it transparent.

## The Problem: Mode Collapse in Planning

[KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9) is our agentic runtime — it takes a task, generates a plan (a sequence of tool calls), executes it, observes results, and replans. The planner is an LLM that produces structured JSON plans. One call, one plan, one strategy.

Here's what happens when you ask it to plan "Research Tokyo weather, find a ramen restaurant, and draft a 2-day travel itinerary":

```
Strategy: browser-only
Steps: navigate → get_text → navigate → snapshot → respond
Tools: browser, respond
```

Every time, the planner defaults to browser automation. Navigate to a weather site, scrape it. Navigate to a restaurant guide, scrape that too. It's the "highway" — safe, sequential, obvious.

But there's a completely different approach: use direct HTTP API calls. Hit `wttr.in/Tokyo?format=j1` for structured weather JSON. GET `timeout.com/tokyo/restaurants/best-ramen` for restaurant data. No browser automation needed. Fewer steps, more structured data, faster execution.

The planner never generates this alternative because it has no reason to — it found a valid strategy and stopped looking. Mode collapse.

## The Fix: Adaptive Beam Search (K=2)

Inspired by ProbDreamer, we built a `BeamPlanner` that wraps any existing planner as a decorator. The algorithm:

1. **Classify complexity** — Is this task trivial, moderate, or complex?
2. **If simple → K=1** — delegate directly, zero overhead. "What is 2+2" doesn't need a second opinion.
3. **If complex → K=2** — generate a primary plan, then generate a *contrastive* alternative with a modified prompt: "Here's the primary plan. Generate a fundamentally different approach."
4. **Score both** — evaluate structural quality, goal advancement, strategy diversity, parsimony, and tool familiarity.
5. **Pick the winner.**

The complexity classifier looks at:
- Task word count (short tasks are trivial)
- Execution history (failures bump to complex)
- Iteration depth (replanning after iteration 3+ is complex)
- Tool count × task length (many tools + long task = complex)

The contrastive prompt is the key innovation over naive temperature variation. Cranking up temperature produces surface-level lexical differences — the same strategy with different variable names. The contrastive prompt forces a *structurally different* approach by telling the model "don't use these tools in this order."

## The Experiment

We ran three test cases, each mapping to a failure mode identified in the ProbDreamer paper:

### Test 1: Bimodal Strategy — "Get Bitcoin price + top HN headline"

Two independent data sources, each fetchable via API or browser. The planner needs to pick a strategy for each.

| | Baseline | Beam (primary won, 92 vs 71) |
|---|---|---|
| Strategy | HN Firebase: 2 API calls (get IDs → get item) | HN Algolia: 1 API call (direct search) |
| Steps | 4 | 3 |
| Cost | $0.05 | $0.18 |

**Result:** Beam's primary plan was smarter — it discovered the Algolia API endpoint that returns the top story in a single call, eliminating the intermediate ID-fetch step. The alternative tried a browser-only approach but scored lower on structural quality. The baseline never considered Algolia.

### Test 2: Overcautious Planning — "Tokyo weather + ramen + 2-day itinerary"

A multi-goal task where the planner must gather data from multiple domains and synthesize.

| | Baseline | Beam (**alternative won**, 87 vs 61) |
|---|---|---|
| Strategy | Browser-only (nav → scrape × 2) | **HTTP API-first** (wttr.in + TimeOut + fallback) |
| Steps | 5 | 4 |
| Tools | browser, respond | **http-request**, respond |
| Cost | $0.21 | $0.24 |

**Result: The alternative won.** This is the money shot. Both the baseline and beam's primary plan defaulted to browser automation — the "safe highway" strategy. The contrastive alternative discovered a pure API approach: `wttr.in` for structured weather JSON, direct HTTP GET to TimeOut Tokyo, plus a japan-guide.com fallback. It scored higher on structural quality (30 vs 10) and parsimony (12 vs 6).

**Without beam search, the planner would never have explored the API-first strategy.** This is exactly the mode collapse that ProbDreamer identified — collapsing two valid strategies (browser vs API) into the more common one.

### Test 3: Simple Task — "Find top 3 trending GitHub repos"

| | Baseline | Beam |
|---|---|---|
| Strategy | browser: nav → snapshot → get_text → respond | Same (beam not triggered) |
| Steps | 4 | 4 |
| Cost | $0.04 | $0.03 |

**Result:** Beam correctly classified this as trivial (12 words, no execution history) and skipped the second LLM call entirely. Zero overhead on simple tasks. This validates the adaptive K — you don't need a second opinion when the task is straightforward.

## Scoring Breakdown

Each candidate plan is scored 0–100 across five dimensions:

| Component | Weight | What It Measures |
|-----------|--------|------------------|
| Structural quality | 30 | Dependencies declared for respond steps, no duplicate tool+input combos |
| Goal advancement | 25 | References prior results via `input_from`, doesn't re-fetch available data |
| Strategy diversity | 20 | Uses tools not used in previous iterations; penalizes repeating failed tools |
| Parsimony | 15 | Fewer steps = higher score (Occam's razor) |
| Tool familiarity | 10 | Tools that succeeded in past sessions get a bonus |

The scoring is deliberately simple — no LLM-as-judge, no learned weights. It's a heuristic that can be computed in microseconds. The heavy lifting is done by the contrastive generation; the scorer just needs to be directionally correct.

## What We Learned

### ProbDreamer's predictions held up

| Paper Prediction | What We Observed |
|---|---|
| K=2 avoids mode collapse | Confirmed — Test 2's alternative beat the "safe" browser default |
| Single-trajectory "freezing" | Baseline Test 2 was sequential browser-only — the overcautious approach |
| K=2 sufficient, K>2 unnecessary | Validated — contrastive prompting produces genuinely different strategies |
| Simple tasks: K=1 optimal | Confirmed — adaptive classifier correctly skipped beam on trivial tasks |

### The cost is manageable

Beam search roughly doubles the planner cost (~2x LLM calls). But it only fires on complex tasks — roughly 20–30% of real workloads. Simple questions, follow-ups, and single-tool tasks are unaffected. For the cases where it does fire, the improved plan quality (fewer steps, better tool selection, higher structural quality) often *reduces* execution cost downstream.

### Contrastive > Temperature

We considered three approaches before landing on contrastive generation:

- **Option A: Temperature variation** — Generate two plans at different temperatures. This produces surface-level differences (different variable names, reordered steps) but the same underlying strategy. Useless.
- **Option B: Single-call dual output** — Ask the LLM to generate two alternatives in one call. This produces "me too" alternatives that look different but follow the same logic. The second plan is always a minor variation of the first.
- **Option C: Contrastive generation** — Generate a primary plan, then explicitly prompt for "a fundamentally different approach that doesn't use these tools in this order." This forces genuine strategic divergence.

Option C won decisively. The key is that the contrastive prompt provides *negative examples* — "here's what NOT to do" — which forces the model to move beyond the strategy its internal reasoning already converged on. Even a reasoning model that "considered" alternatives during chain-of-thought will default to the same modal output on a second call with the same prompt. The contrastive prompt breaks that attractor.

## Implementation

The implementation is a decorator pattern — `BeamPlanner` wraps any `Planner` implementation and exposes the same interface. Zero changes to the kernel. The code lives in a single file (`beam-planner.ts`, ~280 lines) with three exports:

```typescript
// Turn it on with a flag or env var
const planner = new BeamPlanner({
  delegate: existingPlanner,
  beamThreshold: "complex"  // or "moderate" for more aggressive exploration
});

// Same interface — kernel doesn't know beam search exists
const result = await planner.generatePlan(task, tools, snapshot, constraints);

// Observability via metadata
if (result.metadata?.beam_search) {
  console.log(result.metadata.beam_search);
  // { triggered: true, complexity: "moderate",
  //   primary_score: { total: 61 }, alternative_score: { total: 87 },
  //   winner: "alternative", primary_tools: ["browser"], alternative_tools: ["http-request"] }
}
```

Enable it with `--beam` on the CLI or `KARNEVIL9_BEAM=1` in the environment.

## What's Next

This is version 1. Some ideas we're exploring:

- **Scoring with execution feedback** — Right now the scorer uses static heuristics. After a plan executes, we could update scoring weights based on what actually worked. The ProbDreamer paper's free energy scoring (`V(h,z) + β·σ²`) suggests weighting by predicted value plus epistemic uncertainty.
- **Conditional K** — Instead of binary K=1 or K=2, dynamically set K based on the number of distinct tool categories available. If you only have 2 tools, a second opinion adds little.
- **Contrastive chains** — For extremely complex tasks, generate the contrastive plan *after seeing the primary's execution results*, not just the plan. "Plan A tried X and failed — what's a completely different approach?"
- **Ensemble disagreement for complexity classification** — The paper found that ensemble disagreement (σ²) collapsed too quickly to be useful for curiosity. But for *classifying* whether a task needs beam search, brief ensemble probing might work.

## Try It

KarnEvil9 is open source. The beam planner is in `packages/planner/src/beam-planner.ts`. Run a comparison yourself:

```bash
# Baseline — single trajectory
karnevil9 plan --planner claude-code "your complex task here"

# Beam search — K=2 with contrastive alternative
KARNEVIL9_BEAM_THRESHOLD=moderate karnevil9 plan --planner claude-code --beam "your complex task here"
```

The beam search metadata in the output shows you exactly what happened: which plans were generated, how they scored, and which one won.

---

*The ProbDreamer paper showed that two hypotheses beat one in world models. Turns out the same is true for planning. Sometimes the best thing you can do for your agent is give it a second opinion.*

---

**References:**

- Wong, G. (2026). *Probabilistic Dreaming for World Models*. ICLR 2026. [arXiv:2603.04715](https://arxiv.org/abs/2603.04715)
- KarnEvil9 runtime: [github.com/oldeucryptoboi/KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9)
