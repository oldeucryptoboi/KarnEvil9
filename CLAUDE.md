# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KarnEvil9 is a deterministic agent runtime with explicit plans, typed tools, permissions, and replay. It orchestrates LLM-generated plans into structured step execution with permission gates, an immutable event journal, and cross-session learning.

## Build & Development Commands

```bash
pnpm build          # Build all packages (tsc -b in each)
pnpm dev            # Watch mode across all packages in parallel
pnpm test           # Run all unit tests (vitest run in each package)
pnpm test:e2e       # Run e2e smoke tests (tests/e2e/**/*.smoke.ts)
pnpm lint           # Lint all packages
pnpm clean          # Remove dist directories
```

To run tests for a single package:
```bash
cd packages/<name> && pnpm test
# or: pnpm --filter @karnevil9/<name> test
```

To run a single test file:
```bash
npx vitest run packages/<name>/src/<file>.test.ts
```

## Tech Stack

- **TypeScript 5.7+** with strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`
- **Node.js 20+**, ES Modules (`"type": "module"`)
- **pnpm 9.15** monorepo with workspaces
- **Vitest 3.0+** for testing (30s timeout, node environment)
- **Express 5** for the REST API
- **AJV** for JSON Schema validation at all component boundaries

## Repository Layout

```
packages/              # 15 @karnevil9/* npm workspace packages
plugins/               # 15 runtime plugins (discovered dynamically)
extensions/
  cdp-bridge/          # Chrome DevTools Protocol bridge extension
tools/
  manifests/           # Production tool YAML manifests (read-file, shell-exec, etc.)
examples/
  demos/               # Agentic, swarm, resilience, metrics demos
  games/               # Zork emulators, IF kernel runner, zork1.z3
  utilities/           # One-off utility scripts
docs/                  # Jekyll site, whitepapers/, blog/, demos/
tests/e2e/             # Smoke tests
infra/                 # Infrastructure config
```

## Monorepo Architecture

All packages live under `packages/` and are scoped as `@karnevil9/*`. The dependency flow is strictly bottom-up:

```
schemas                     ← Foundation: all types, validators, error codes
  ↓
journal, permissions, memory  ← Core infrastructure
  ↓
tools                       ← Tool registry, runtime, handlers, policy enforcement
  ↓
planner, plugins            ← Plan generation (LLM adapters) & plugin system
  ↓
kernel                      ← Main orchestrator: wires everything together
  ↓
api, cli, browser-relay     ← Entry points
```

### Key Packages

- **schemas** — All shared TypeScript interfaces (`Session`, `Task`, `Plan`, `Step`, `StepResult`, `ToolManifest`, `PermissionGrant`, `JournalEvent`). Every other package imports types from here. Error codes are enumerated as `ErrorCodes`.
- **kernel** — Central orchestrator. Manages session lifecycle (`created → planning → running → completed/failed/aborted`), runs planning and execution phases, supports agentic mode (iterative re-planning), futility detection, and context budget management.
- **journal** — Append-only JSONL event log with SHA-256 hash-chain integrity. Supports listeners, session indexing, and optional payload redaction.
- **permissions** — `domain:action:target` permission strings with multi-level caching (global/session/step scope). Decisions include `allow_once`, `allow_session`, `allow_always`, `allow_constrained`, `allow_observed`, `deny`.
- **tools** — ToolRegistry + ToolRuntime with circuit breaker pattern (threshold=5, cooldown=30s). Built-in handlers: readFile, writeFile, shellExec, httpRequest, browser. PolicyEnforcer handles SSRF protection, path validation, command filtering.
- **planner** — MockPlanner (testing), LLMPlanner (Claude/OpenAI/Gemini/Grok with prompt injection prevention via `<<<UNTRUSTED_INPUT>>>` delimiters), RouterPlanner (domain-aware routing).
- **plugins** — Discovery (`plugin.yaml` manifests), loader, registry. Plugins register tools, hooks (`before_*/after_*`), routes, commands, and services. Hook runner supports continuation, modification, and blocking.
- **memory** — TaskStateManager (in-session plan/step/artifact tracking), WorkingMemoryManager (KV store), LongTermMemory/ActiveMemory (cross-session lesson persistence in JSONL).

## Execution Flow

**Single-shot**: `createSession(task) → planPhase() → executePhase() → done`

**Agentic mode**: Loops `planPhase() → executePhase()` until the planner returns an empty plan or a halt condition is met (futility, budget exceeded, max iterations).

Steps execute with max 5 concurrency. Each step goes through: input validation → permission check → tool execution → output validation → result recording.

## Plugin System

Plugins are discovered from a directory, each containing a `plugin.yaml` manifest and a JS entry module that exports a `register(api)` function. The PluginAPI provides `registerTool()`, `registerHook()`, `registerRoute()`, `registerCommand()`, `registerService()`. See `plugins/example-logger/` for reference.

## Git Workflow

- **Never push directly to master.** Create a feature branch and open a PR via `gh pr create`.
- Branch naming: `feat/<short-description>`, `fix/<short-description>`, `refactor/<short-description>`
- PRs should include a summary of changes and a test plan.
- After PR approval/merge, delete the stale schedule entries from `sessions/schedules.jsonl` (or via `DELETE /api/schedules/:id`) and restart the server so updated schedules get auto-created.

## Conventions

- All packages use ESM (`"type": "module"`) with `tsc -b` for building
- Composite TypeScript project references connect the monorepo
- Validation happens at component boundaries using AJV against JSON schemas
- Async patterns: Promise-based with `Promise.race()` for timeouts, exponential backoff with jitter for retries
- Journal events are the primary observability mechanism (not ad-hoc logging)
- API keys are loaded from `.env` via dotenv (`ANTHROPIC_API_KEY`, etc.)
