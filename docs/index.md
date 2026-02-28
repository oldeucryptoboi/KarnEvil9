---
layout: default
title: "KarnEvil9 — Deterministic AI Agent Runtime"
description: "Open-source deterministic agent runtime implementing Google DeepMind's Intelligent AI Delegation framework. TypeScript, typed tools, permissions, tamper-evident replay."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "name": "KarnEvil9",
  "description": "Deterministic agent runtime with explicit plans, typed tools, permissions, and replay. First open-source implementation of Google DeepMind's Intelligent AI Delegation framework.",
  "url": "https://oldeucryptoboi.github.io/KarnEvil9",
  "codeRepository": "https://github.com/oldeucryptoboi/KarnEvil9",
  "programmingLanguage": "TypeScript",
  "license": "https://opensource.org/licenses/MIT",
  "author": {
    "@type": "Person",
    "name": "Laurent DeSegur",
    "url": "https://twitter.com/oldeucryptoboi"
  },
  "about": [
    "AI agents",
    "Multi-agent systems",
    "AI safety",
    "Google DeepMind Intelligent AI Delegation"
  ]
}
</script>

# KarnEvil9

**Deterministic agent runtime with explicit plans, typed tools, permissions, and replay.** KarnEvil9 is the first open-source implementation of Google DeepMind's [Intelligent AI Delegation](whitepapers/intelligent-delegation) framework ([Tomasev, Franklin & Osindero, 2026](https://arxiv.org/abs/2602.11865)), translating all five pillars of the paper into runnable TypeScript.

KarnEvil9 converts a natural-language task into a structured execution plan, runs each step under fine-grained permission control, and records every event in a SHA-256 hash-chain journal. It supports single-shot execution, an agentic feedback loop with iterative re-planning, and P2P task delegation across a swarm mesh with nine safety mechanisms.

## What problems does KarnEvil9 solve?

Most AI agent frameworks treat execution as a black box — prompts go in, actions come out, and there is no structured audit trail. KarnEvil9 addresses this with:

- **Deterministic execution** — Plans are explicit data structures, not opaque prompt chains. Every run is replayable and auditable.
- **Accountability by design** — Trust scores, escrow bonds, and automatic re-delegation on failure.
- **Domain-ignorant governance** — Safety layers own trust and chain depth, not domain knowledge.
- **Tamper-evident journal** — SHA-256 hash-chain event log detects post-hoc modification.

## How does KarnEvil9 implement Google DeepMind's Intelligent AI Delegation?

The `@karnevil9/swarm` package translates the five pillars of the Tomasev et al. paper into nine safety mechanisms:

| Component | Paper Pillar | Purpose |
|-----------|-------------|---------|
| Cognitive Friction Engine | Dynamic Assessment | Risk-weighted human oversight |
| Delegatee Router | Dynamic Assessment | AI vs. human routing |
| Liability Firebreaks | Systemic Resilience | Depth limits by criticality |
| Graduated Authority | Systemic Resilience | Trust-tier-scaled permissions |
| Escrow Bond Manager | Scalable Market | Stake-based accountability |
| Outcome Verifier | Structural Transparency | Multi-dimensional SLO checks |
| Consensus Verifier | Structural Transparency | Multi-peer agreement |
| Reputation Store | Scalable Market | Bayesian trust tracking |
| Re-delegation Pipeline | Adaptive Execution | Automatic recovery |

[Read the full whitepaper →](whitepapers/intelligent-delegation)

## How is KarnEvil9 architected?

KarnEvil9 is a TypeScript monorepo with 15 packages:

```
schemas → journal, permissions, memory → tools → planner, plugins → kernel → api → cli
```

[Full architecture reference →](architecture)

## How does KarnEvil9 handle AI safety?

KarnEvil9 implements runtime-enforced safety guardrails including permission gates on every tool invocation, policy enforcement (SSRF protection, path allowlisting, command filtering), prompt injection prevention, credential sanitization, and circuit breakers.

[Read the Three Laws whitepaper →](whitepapers/three-laws)

## Case study: AI agent plays Zork I through governed delegation

We tested KarnEvil9 by building a three-node AI swarm to play Zork I. A Strategist (Claude) decides moves, a Tactician executes them against a Z-machine emulator, and a Cartographer independently verifies game state. The DeepMind governance framework initially blocked the agent from attacking a troll — the fix revealed a key insight about separating domain intelligence from accountability.

[Read the Zork experiment →](whitepapers/zork-swarm-experiment)

## Quick Start

```bash
npm install -g karnevil9
# or
pnpm install && pnpm build

karnevil9 run "list all TypeScript files" --planner claude --mode real
```

## Documentation

- [Architecture Reference](architecture)
- [Roadmap: KarnEvil9 Computer](roadmap)
- [Intelligent AI Delegation Whitepaper](whitepapers/intelligent-delegation)
- [Three Laws Safety Whitepaper](whitepapers/three-laws)
- [Zork Swarm Experiment](whitepapers/zork-swarm-experiment)
- [Claude Code Hello World Tutorial](demos/claude-code-hello-world.html)

## Links

- [GitHub Repository](https://github.com/oldeucryptoboi/KarnEvil9)
- [npm Package](https://www.npmjs.com/package/karnevil9)
- [Substack](https://oldeucryptoboi.substack.com)

---

Built by [Laurent DeSegur](https://twitter.com/oldeucryptoboi) and E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine).

Named after Emerson, Lake & Palmer's "Karn Evil 9" from *Brain Salad Surgery* (1973).
