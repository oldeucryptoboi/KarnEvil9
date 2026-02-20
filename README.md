# KarnEvil9

Deterministic agent runtime with explicit plans, typed tools, permissions, replay, and a reference implementation of Google DeepMind's [Intelligent AI Delegation](docs/intelligent-delegation-whitepaper.md) framework.

KarnEvil9 converts a natural-language task into a structured execution plan, runs each step under fine-grained permission control, and records every event in a tamper-evident journal. It supports single-shot execution, an agentic feedback loop with iterative re-planning, and P2P task delegation across a swarm mesh with nine safety mechanisms derived from the [Tomasev, Franklin & Osindero (2026)](https://arxiv.org/abs/2503.02116) framework: cognitive friction, liability firebreaks, graduated authority, escrow bonds, outcome verification, consensus verification, reputation tracking, delegatee routing, and re-delegation.

> **[Intelligent AI Delegation: From Theory to Working Code](docs/intelligent-delegation-whitepaper.md)** — KarnEvil9 serves as the foundation for a complete, working implementation of Google DeepMind's *Intelligent AI Delegation* framework. The whitepaper details how every pillar of the Tomasev et al. paper is translated into runnable code within the `@karnevil9/swarm` package, demonstrated through a controlled experiment comparing naive vs. intelligent delegation across a three-node P2P mesh.

## Quick Start

```bash
# Prerequisites: Node.js >= 20, pnpm >= 9.15
pnpm install
pnpm build

# Run a task (mock mode — no API keys required)
karnevil9 run "read the contents of package.json"

# Run with an LLM planner
export ANTHROPIC_API_KEY=sk-...
karnevil9 run "list all TypeScript files in src/" --planner claude --mode real

# Agentic mode (iterative planning)
karnevil9 run "refactor utils into separate modules" --planner claude --mode real --agentic

# Start the server + interactive chat
karnevil9 server --planner claude --agentic
karnevil9 chat
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `karnevil9 run <task>` | Execute a task end-to-end |
| `karnevil9 plan <task>` | Generate a plan without executing |
| `karnevil9 chat` | Interactive chat session via WebSocket |
| `karnevil9 server` | Start the REST/WebSocket API server |
| `karnevil9 tools list` | List registered tools |
| `karnevil9 session ls` | List sessions from journal |
| `karnevil9 session watch <id>` | Watch session events |
| `karnevil9 replay <id>` | Replay session events with integrity check |
| `karnevil9 relay` | Start the browser automation relay |
| `karnevil9 plugins list\|info\|reload` | Plugin management |

### Key Options

```
--mode <mode>         Execution mode: mock, dry_run, real (default: mock)
--planner <type>      Planner backend: mock, claude, openai, router
--model <name>        LLM model name
--agentic             Enable iterative plan-execute-replan loop
--context-budget      Proactive context budget management (requires --agentic)
--max-steps <n>       Maximum steps (default: 20)
--plugins-dir <dir>   Plugin directory (default: plugins)
--no-memory           Disable cross-session learning
--browser <mode>      Browser driver: managed or extension (default: managed)
--insecure            Allow running without an API token
```

## API Server

```bash
karnevil9 server --port 3100 --planner claude --agentic
```

### REST Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/sessions` | Create and run a session |
| `GET /api/sessions/:id` | Get session status |
| `GET /api/sessions/:id/stream` | SSE event stream |
| `GET /api/sessions/:id/journal` | Paginated journal events |
| `POST /api/sessions/:id/abort` | Abort a running session |
| `POST /api/sessions/:id/recover` | Recover a failed session |
| `POST /api/sessions/:id/replay` | Replay session events |
| `GET /api/approvals` | List pending permission requests |
| `POST /api/approvals/:id` | Submit approval decision |
| `GET /api/tools` | List available tools |
| `GET /api/plugins` | List loaded plugins |
| `GET /api/plugins/:id` | Plugin details |
| `POST /api/plugins/:id/reload` | Reload a plugin |
| `POST /api/plugins/:id/unload` | Unload a plugin |
| `GET /api/health` | System health check |
| `GET /api/metrics` | Prometheus metrics |
| `POST /api/journal/compact` | Compact the journal |

### WebSocket

Connect to `ws://localhost:3100/api/ws` for interactive sessions. The chat CLI uses this endpoint. Messages: `submit`, `abort`, `approve`, `ping`/`pong`. Server pushes `session.created`, `event`, `approve.needed`, `error`.

## Architecture

KarnEvil9 is a pnpm monorepo with 15 packages under `packages/`, all scoped as `@karnevil9/*`:

```
schemas                       <- Foundation: types, validators, error codes
  |
journal, permissions, memory  <- Core infrastructure
  |
tools                         <- Registry, runtime, policy enforcement, handlers
  |
planner, plugins              <- LLM adapters & extensibility
  |
kernel                        <- Orchestrator: session lifecycle, execution phases
  |
metrics, scheduler,           <- Observability, scheduled jobs,
swarm, vault                     P2P intelligent delegation & knowledge vault
  |
api                           <- REST/WebSocket server
  |
cli, browser-relay            <- Entry points
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture reference.

### Execution Flow

**Single-shot:** Plan once, execute all steps, done.

**Agentic:** Loop of plan -> execute -> observe results -> replan, until the planner signals completion or a halt condition triggers (futility detection, budget exceeded, max iterations).

Each step passes through: input validation -> permission check -> tool execution -> output validation -> result recording.

## Built-in Tools

| Tool | Description |
|------|-------------|
| `read-file` | Read files with symlink-safe path validation |
| `write-file` | Write files with approval flow and atomic writes |
| `shell-exec` | Execute shell commands with env sanitization and command filtering |
| `http-request` | HTTP requests with SSRF protection |
| `browser` | Browser automation via relay (Playwright or extension) |

## Permission System

Permissions use a `domain:action:target` format (e.g., `filesystem:write:workspace`). The engine supports six decision types:

- **allow_once** — single step
- **allow_session** — lifetime of session
- **allow_always** — persists across sessions
- **allow_constrained** — with path/endpoint restrictions
- **allow_observed** — with telemetry logging
- **deny** — with optional alternative tool suggestion

## Plugin System

Plugins are directories containing a `plugin.yaml` manifest and a JS entry module:

```yaml
id: my-plugin
name: My Plugin
version: 1.0.0
description: What it does
entry: index.js
permissions: []
provides:
  hooks: [before_step, after_step]
  tools: []
```

The entry module exports a `register(api)` function that can call `registerTool()`, `registerHook()`, `registerRoute()`, `registerCommand()`, and `registerService()`. See `plugins/example-logger/` for a working example.

### Included Plugins

| Plugin | Description |
|--------|-------------|
| `claude-code` | Delegates coding tasks to Claude Code via the Anthropic agent SDK |
| `openai-codex` | Delegates coding tasks to OpenAI Codex via the Codex SDK |
| `example-logger` | Reference plugin demonstrating hooks and event logging |
| `scheduler-tool` | Exposes the scheduler as a tool for creating scheduled jobs |
| `slack` | Bidirectional Slack integration: receive tasks, post progress, approval buttons |
| `signal` | Bidirectional Signal messaging via native signal-cli |
| `whatsapp` | Bidirectional WhatsApp messaging via Baileys/WhatsApp Web protocol |
| `gmail` | Gmail integration with OAuth2 and Pub/Sub webhook support |
| `grok-search` | Grok/X search integration |
| `swarm` | P2P intelligent delegation mesh across KarnEvil9 instances |
| `vault` | Ontology knowledge vault with vector search, clustering, and Obsidian-native storage |

See the [Claude Code Hello World tutorial](https://oldeucryptoboi.github.io/KarnEvil9/claude-code-hello-world.html) for a full walkthrough.

## Intelligent AI Delegation

The `@karnevil9/swarm` package is a complete implementation of Google DeepMind's [Intelligent AI Delegation](https://arxiv.org/abs/2503.02116) framework (Tomasev, Franklin & Osindero, 2026). Nine safety mechanisms translate the paper's five pillars — dynamic assessment, adaptive execution, structural transparency, scalable market coordination, and systemic resilience — into runnable code:

| Component | Paper Pillar | Purpose |
|-----------|-------------|---------|
| Cognitive Friction Engine | Dynamic Assessment | Risk-weighted human oversight; anti-alarm-fatigue throttling |
| Delegatee Router | Dynamic Assessment | AI vs. human routing based on task attributes |
| Liability Firebreaks | Systemic Resilience | Depth limits that tighten with task criticality |
| Graduated Authority | Systemic Resilience | Trust-tier-scaled SLOs, monitoring, and permissions |
| Escrow Bond Manager | Scalable Market | Stake-based accountability with slashing on SLO violation |
| Outcome Verifier | Structural Transparency | Multi-dimensional SLO checks (quality, latency, cost, tokens) |
| Consensus Verifier | Structural Transparency | Multi-peer agreement with configurable quorum |
| Reputation Store | Scalable Market | Bayesian trust tracking with exponential decay |
| Re-delegation Pipeline | Adaptive Execution | Automatic recovery with bond slashing and peer blacklisting |

The framework forms a closed loop: delegation failure triggers bond slashing, reputation downgrade, re-delegation to a higher-trust peer, and consensus verification — all within a single execution cycle.

See the full [whitepaper](docs/intelligent-delegation-whitepaper.md) for component deep dives, quantitative results, and a controlled naive-vs-intelligent demonstration.

## Knowledge Vault

The `@karnevil9/vault` package is a Palantir-inspired ontology knowledge store with Obsidian-native markdown storage:

- **7 ingestion adapters**: Journal, ChatGPT, Claude, WhatsApp, Apple Notes, Gmail, Google Drive
- **Entity extraction & deduplication**: fuzzy matching with alias YAML, LLM-powered classification
- **Vector search**: in-memory embeddings with cosine similarity kNN, OPTICS clustering
- **Relationship discovery**: embed, cluster, find pairs, dedup, label, create links — fully automated
- **Dashboard generation**: health metrics, top entities, clusters, Dataview queries, LLM-generated insights
- **PARA folder structure**: Projects, Areas, Resources, Archive with `_Ontology/` for schema

## Metrics & Monitoring

KarnEvil9 includes a Prometheus metrics collector and a pre-built Grafana dashboard.

```bash
# Start Prometheus + Grafana
docker compose -f docker-compose.metrics.yml up -d

# Metrics are exposed at GET /api/metrics
curl http://localhost:3100/api/metrics
```

14 metric families covering sessions, steps, tools, tokens, cost, planner, permissions, safety, and plugins. Grafana dashboard with 30 panels across 8 rows.

## Scheduler

Built-in job scheduler supporting one-shot, interval, and cron triggers.

```bash
# Schedules persist to JSONL and survive restarts
# Create schedules via the scheduler-tool plugin or REST API
GET  /api/schedules
POST /api/schedules
GET  /api/schedules/:id
PUT  /api/schedules/:id
DELETE /api/schedules/:id
```

Missed schedule policies: `skip`, `catchup_one`, `catchup_all`.

## Security

- **Permission gates** on every tool invocation with multi-level caching
- **Policy enforcement** — path allowlisting, SSRF protection (private IP blocking, port whitelist), command filtering
- **Prompt injection prevention** — untrusted data wrapped in structured delimiters
- **Journal integrity** — SHA-256 hash chain for tamper detection
- **Credential sanitization** — env vars filtered from shell, payloads redacted in journal
- **Circuit breakers** — per-tool failure tracking prevents cascading failures
- **API authentication** — token-based auth with rate limiting and CORS support
- **Deny-all access control** — messaging plugins (Slack, Signal, WhatsApp, Gmail) deny all users when allowlist is empty
- **Swarm token validation** — all peer POST endpoints require shared secret authentication
- **Dangerous command detection** — shell tool flags `rm -rf`, `find -delete`, `sed -i`, etc.
- **Escrow bonds & reputation slashing** — financial and trust penalties for SLO violations in delegation

## Development

```bash
pnpm build        # Build all packages
pnpm dev          # Watch mode (parallel)
pnpm test         # Run all unit tests
pnpm test:e2e     # Run e2e smoke tests
pnpm lint         # Lint all packages
pnpm clean        # Remove dist directories

# Single package
pnpm --filter @karnevil9/kernel test
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For Claude planner | Anthropic API key |
| `OPENAI_API_KEY` | For OpenAI planner | OpenAI API key |
| `KARNEVIL9_API_TOKEN` | For server auth | API token for REST/WebSocket auth |
| `KARNEVIL9_PORT` | No | Server port (default: 3100) |
| `KARNEVIL9_JOURNAL_PATH` | No | Journal file path |
| `KARNEVIL9_MEMORY_PATH` | No | Memory file path |
| `KARNEVIL9_SCHEDULER_PATH` | No | Scheduler file path |
| `KARNEVIL9_CORS_ORIGINS` | No | Comma-separated allowed CORS origins |
| `KARNEVIL9_APPROVAL_TIMEOUT_MS` | No | Approval timeout (default: 300000) |
| `KARNEVIL9_MAX_SESSIONS` | No | Max concurrent sessions (default: 50) |
| `KARNEVIL9_CLAUDE_CODE_MODEL` | No | Claude Code model override |
| `KARNEVIL9_CLAUDE_CODE_MAX_TURNS` | No | Max agentic turns per Claude Code invocation (default: 30) |
| `KARNEVIL9_CODEX_MODEL` | No | OpenAI Codex model override |
| `SLACK_BOT_TOKEN` | For Slack plugin | Slack bot token |
| `SLACK_APP_TOKEN` | For Slack socket mode | Slack app-level token |
| `KARNEVIL9_SWARM_ENABLED` | No | Enable swarm mesh (`true`/`false`) |
| `KARNEVIL9_SWARM_TOKEN` | For swarm auth | Shared secret for peer authentication |
| `KARNEVIL9_SWARM_SEEDS` | No | Comma-separated seed URLs for peer discovery |
| `KARNEVIL9_VAULT_ROOT` | For vault plugin | Obsidian vault root directory |
| `KARNEVIL9_VAULT_CLASSIFIER_MODEL` | No | Anthropic model for entity classification |
| `KARNEVIL9_VAULT_EMBEDDING_MODEL` | No | OpenAI model for vector embeddings |
| `SLACK_ALLOWED_USER_IDS` | For Slack security | Comma-separated allowed Slack user IDs |
| `SIGNAL_ALLOWED_NUMBERS` | For Signal security | Comma-separated allowed Signal phone numbers |
| `WHATSAPP_ENABLED` | For WhatsApp plugin | Enable WhatsApp integration (`true`/`false`) |
| `WHATSAPP_ALLOWED_NUMBERS` | For WhatsApp security | Comma-separated allowed WhatsApp numbers |

Create a `.env` file in the project root (gitignored).

## License

Private
