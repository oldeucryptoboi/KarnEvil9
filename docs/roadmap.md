---
layout: default
title: "Roadmap: KarnEvil9 Computer"
description: "Turning KarnEvil9 from a deterministic agent runtime into a full autonomous project execution system."
---

# Roadmap: KarnEvil9 Computer

KarnEvil9 has the orchestration backbone for autonomous project execution — planning loops, sub-agents, scheduling, permissions, memory, and an auditable journal. What's missing are the **edges**: connectors in, artifacts out, and a UI on top.

This roadmap defines the path from deterministic agent runtime to full autonomous "Computer" — an open-source, self-hosted, auditable alternative to closed systems like Perplexity Computer.

## Current State

| Capability | Status | Package |
|---|---|---|
| Agentic re-planning loop | Complete | `@karnevil9/kernel` |
| Sub-agent spawning with budget constraints | Complete | `@karnevil9/kernel` (subagent.ts) |
| Permission gates (`domain:action:target`) | Complete | `@karnevil9/permissions` |
| Hash-chained immutable journal | Complete | `@karnevil9/journal` |
| Deterministic replay from checkpoints | Complete | `@karnevil9/kernel` |
| Cron/interval scheduling with catch-up | Complete | `@karnevil9/scheduler` |
| Cross-session lesson persistence | Complete | `@karnevil9/memory` |
| Browser automation (Playwright/CDP) | Complete | `@karnevil9/browser-relay` |
| P2P swarm delegation with trust/escrow | Complete | `@karnevil9/swarm` |
| Circuit breaker on tool failures | Complete | `@karnevil9/tools` |
| REST API + WebSocket events | Complete | `@karnevil9/api` |
| CLI with interactive approval | Complete | `@karnevil9/cli` |
| LLM adapters (Claude + OpenAI) | Complete | `@karnevil9/planner` |
| Domain-aware task routing | Complete | `@karnevil9/planner` (RouterPlanner) |
| Plugin system (tools, hooks, routes) | Complete | `@karnevil9/plugins` |

## Phase 1: Multi-Model Router

**Goal:** Route tasks to the right model based on complexity, cost, and domain — not just provider.

### What exists
- `RouterPlanner` classifies tasks into domains (file_ops, network, shell, code_gen, social, general) and delegates to a configured planner per domain.
- Two LLM adapters: Claude (Anthropic) and OpenAI.

### What's needed
- **Model complexity heuristic** — Classify steps as simple/medium/complex based on token estimate, tool count, and dependency depth. Route simple tasks to fast/cheap models (Haiku, GPT-4o-mini), complex tasks to strong models (Opus, o1).
- **Fallback chains** — If primary model fails or times out, cascade to next provider. E.g., Claude Opus -> Claude Sonnet -> OpenAI GPT-4o.
- **Additional adapters** — Google Gemini, Mistral, local models (Ollama/vLLM). Each adapter implements the existing `Planner` interface.
- **Cost tracking per model** — Extend the existing token/cost budget system to track spend per provider and optimize routing based on remaining budget.

### Packages affected
`@karnevil9/planner`

## Phase 2: Service Connector Framework

**Goal:** Pre-built, authenticated integrations with common services so agents can take real-world actions beyond raw HTTP.

### What exists
- `httpRequest` tool handler for arbitrary HTTP calls.
- Environment variable-based API key loading.
- `@karnevil9/vault` package (credential storage).

### What's needed
- **OAuth 2.0 credential store** — Extend vault with OAuth token refresh flows. Store access/refresh tokens encrypted at rest. Support authorization_code and client_credentials grants.
- **Typed service connectors** — Each connector is a plugin that registers domain-specific tools:
  - **GitHub** — create_issue, create_pr, merge_pr, list_repos, read_file
  - **Slack** — send_message, create_channel, list_channels
  - **Gmail / Google Workspace** — send_email, read_inbox, create_doc, update_sheet
  - **Stripe** — create_charge, list_payments, create_invoice
  - **Linear / Jira** — create_issue, update_status, list_sprints
- **Connector SDK** — A base class for building new connectors with auth, rate limiting, and error mapping baked in. Shipped as `@karnevil9/connectors`.

### Packages affected
`@karnevil9/vault`, new `@karnevil9/connectors`, `@karnevil9/plugins` (connector plugins)

## Phase 3: Web Dashboard

**Goal:** Browser-based UI for managing sessions, monitoring execution, and approving permission requests — replacing CLI-only interaction.

### What exists
- REST API with full session/schedule/journal CRUD.
- WebSocket + SSE endpoints for real-time step events.
- Grafana dashboard JSON for metrics.

### What's needed
- **Session list view** — All sessions with status, progress bar (steps completed/total), elapsed time, cost.
- **Live execution viewer** — Real-time step-by-step display as the kernel executes. Show plan graph, current step highlight, tool inputs/outputs, journal events streaming via WebSocket.
- **Approval workflow** — When a step triggers a permission prompt, push a notification to the dashboard. User clicks approve/deny from any device. Replaces CLI readline.
- **Schedule manager** — CRUD for cron schedules, next-run display, execution history.
- **Artifact viewer** — Render markdown, display images, download files produced by sessions.
- **Memory/lesson browser** — View and manage cross-session lessons.

### Tech stack
React + Vite frontend in a new `@karnevil9/dashboard` package. Consumes the existing REST API. No backend changes needed beyond minor API additions.

### Packages affected
New `@karnevil9/dashboard`, minor additions to `@karnevil9/api`

## Phase 4: Artifact Pipeline

**Goal:** Agents produce polished, downloadable outputs — not just string results.

### What exists
- `TaskStateManager` holds artifacts in memory during sessions.
- Steps return `StepResult` with string output.

### What's needed
- **Structured artifact types** — Markdown documents, HTML pages, CSV/JSON data exports, images, code repositories.
- **Rendering pipeline** — Markdown -> HTML -> PDF conversion. Template system for reports (session summary, execution audit, data analysis).
- **Artifact storage** — Persist artifacts to disk or object storage (S3-compatible). Link artifacts to journal events for traceability.
- **Export formats** — PDF reports, ZIP archives of generated code, shareable HTML pages.

### Packages affected
`@karnevil9/kernel` (artifact handling), new `@karnevil9/artifacts`

## Phase 5: Async Human-in-the-Loop

**Goal:** Approval workflows that don't require a terminal or open browser tab.

### What exists
- CLI readline prompts for permission approval.
- WebSocket events for real-time updates.

### What's needed
- **Notification channels** — Slack webhook, email (SMTP/SendGrid), mobile push via web push API.
- **Approve/deny links** — Signed one-time URLs that resolve permission prompts. Agent execution pauses until the link is clicked.
- **Timeout policies** — Auto-deny after configurable timeout. Escalation chains (notify user -> notify admin -> auto-deny).
- **Approval audit trail** — Record who approved, when, from which channel, in the journal.

### Packages affected
`@karnevil9/permissions`, `@karnevil9/api`

## Design Principles

These phases follow the same principles that govern KarnEvil9 today:

1. **Determinism first** — Every new capability must be replayable. Service connector calls are journaled with request/response pairs. Approval decisions are immutable events.
2. **Permission gates on everything** — New connectors register their tools with `domain:action:target` permissions. No GitHub PR gets created without an explicit grant.
3. **Open and self-hosted** — No vendor lock-in. Every component runs on your infrastructure. Credentials never leave your vault.
4. **Auditable by default** — The journal captures every action. Artifacts link back to the steps that produced them.

## Comparison: KarnEvil9 Computer vs Perplexity Computer

| | KarnEvil9 Computer | Perplexity Computer |
|---|---|---|
| Hosting | Self-hosted, your infrastructure | Perplexity-hosted SaaS |
| Models | Pluggable, any provider | 19+ models, closed routing |
| Permissions | Explicit `domain:action:target` gates | Opaque |
| Audit trail | Hash-chained journal, full replay | None public |
| Extensibility | Plugin system, open-source connectors | Closed |
| Cost | OSS + your LLM API costs | $200/mo + usage |
| Data privacy | Credentials and data stay on your infra | Trust the vendor |
| Determinism | Same input = same execution, replayable | Black box |
