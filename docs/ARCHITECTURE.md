# KarnEvil9 Architecture

Deterministic agent runtime with explicit plans, typed tools, permission gates, and replay.

---

## 1. System Overview

KarnEvil9 converts a natural-language task into a structured plan of tool invocations, executes each step under permission control, and records every event in a tamper-evident journal. It supports two execution modes:

- **Single-shot** — one plan, one execution pass, done.
- **Agentic** — iterative loop of plan-execute-observe-replan until the planner signals completion or a halt condition is reached.

```
+---------------------------------------------------------------------+
|                         Entry Points                                 |
|   CLI (commander)    REST API (express 5)    Browser Relay (ws)      |
+----------+------------------+-----------------------+----------------+
           |                  |                       |
           v                  v                       |
+---------------------------------------------+       |
|                  Kernel                      |       |
|  Session lifecycle / Plan+Execute phases     |       |
|  Futility detection / Context budget mgmt    |       |
|  Subagent delegation / Critic system         |       |
+--+------+------+------+------+------+-------+       |
   |      |      |      |      |      |               |
   v      v      v      v      v      v               |
Planner  Tools  Perms  Journal Memory Plugins         |
                  |                                    |
                  v                                    |
            PolicyEnforcer <---------------------------+
                  |
                  v
         Built-in Handlers
   (fs / shell / http / browser)
```

All packages share types from `@karnevil9/schemas` — the sole source of truth for interfaces, validators, and error codes.

---

## 2. Package Dependency Graph

```
@karnevil9/schemas                  ← types, JSON schema validators, error codes
    │
    ├── @karnevil9/journal          ← append-only JSONL event log with hash chain
    ├── @karnevil9/permissions      ← domain:action:target permission engine
    ├── @karnevil9/memory           ← task state, working memory, cross-session lessons
    │
    ├── @karnevil9/tools            ← tool registry, runtime (circuit breaker), policy enforcer, handlers
    │       │
    │       ├── @karnevil9/journal
    │       └── @karnevil9/permissions
    │
    ├── @karnevil9/planner          ← MockPlanner, LLMPlanner, RouterPlanner
    │       └── @karnevil9/schemas
    │
    ├── @karnevil9/plugins          ← discovery, loader, registry, hook runner
    │       ├── @karnevil9/journal
    │       ├── @karnevil9/tools
    │       └── @karnevil9/schemas
    │
    ├── @karnevil9/kernel           ← orchestrator: wires everything together
    │       ├── @karnevil9/journal
    │       ├── @karnevil9/tools
    │       ├── @karnevil9/permissions
    │       ├── @karnevil9/memory
    │       └── @karnevil9/plugins
    │
    ├── @karnevil9/api              ← REST server, SSE streaming, approval workflow
    │       └── @karnevil9/kernel (+ all transitive)
    │
    ├── @karnevil9/cli              ← command-line interface
    │       └── @karnevil9/kernel (+ all transitive)
    │
    └── @karnevil9/browser-relay    ← Playwright managed driver / extension driver
```

---

## 3. Core Data Model

All types are defined in `packages/schemas/src/types.ts`.

### Session

The top-level execution context.

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | UUID | Unique identifier |
| `status` | SessionStatus | `created → planning → running → [awaiting_approval \| paused] → completed \| failed \| aborted` |
| `task` | Task | The user request |
| `active_plan_id` | string? | Currently executing plan |
| `mode` | ExecutionMode | `real`, `dry_run`, or `mock` |
| `limits` | SessionLimits | `max_steps`, `max_duration_ms`, `max_cost_usd`, `max_tokens`, `max_iterations` |
| `policy` | PolicyProfile | `allowed_paths`, `allowed_endpoints`, `allowed_commands`, `require_approval_for_writes` |

Status transitions follow a strict state machine enforced by the kernel. Terminal states are `completed`, `failed`, and `aborted`.

### Task → Plan → Step

```
Task                          Plan                          Step
├─ task_id                    ├─ plan_id                    ├─ step_id
├─ text                       ├─ schema_version ("0.1")     ├─ title / description
├─ constraints                ├─ goal                       ├─ tool_ref {name, version_range?}
│  ├─ allowed_tools           ├─ assumptions[]              ├─ input: Record<string, unknown>
│  ├─ denied_tools            ├─ steps: Step[]              ├─ input_from: {step_id: field}
│  └─ scope (paths)           ├─ artifacts[]                ├─ depends_on: step_id[]
└─ submitted_by               └─ created_at                 ├─ success_criteria[]
                                                            ├─ failure_policy (abort|replan|continue)
                                                            ├─ timeout_ms (≥100)
                                                            └─ max_retries (0–10)
```

A **Plan** must have at least one step. In agentic mode, a plan with zero steps is the planner's "done" signal.

### StepResult

Captures execution outcome per step: `status` (pending/running/succeeded/failed/skipped), `output`, `error` (code + message + data), timestamps, and attempt count.

### ToolManifest

Declares a tool's name (pattern: `^[a-z][a-z0-9_-]*$`), version (semver), runner type (`shell`/`http`/`internal`/`container`), input/output JSON schemas, required permissions, timeout, and mock response support. All manifests must set `supports.mock: true`.

### JournalEvent

44 event types across 12 domains: `session.*`, `planner.*`, `plan.*`, `step.*`, `tool.*`, `permission.*`, `policy.*`, `plugin.*`, `memory.*`, `futility.*`, `usage.*`, `context.*`, plus `limit.exceeded` and `session.checkpoint`.

Each event carries `event_id`, `timestamp`, `session_id`, `type`, `payload`, `seq` (global counter), and `hash_prev` (SHA-256 of prior event for chain integrity).

### Error Codes

18 enumerated codes in `ErrorCodes`: `TOOL_NOT_FOUND`, `CIRCUIT_BREAKER_OPEN`, `INVALID_INPUT`, `INVALID_OUTPUT`, `PERMISSION_DENIED`, `POLICY_VIOLATION`, `EXECUTION_ERROR`, `TIMEOUT`, `DURATION_LIMIT`, `SESSION_LIMIT_REACHED`, `NO_RUNTIME`, `PLUGIN_NOT_FOUND`, `PLUGIN_LOAD_FAILED`, `PLUGIN_TIMEOUT`, `PLUGIN_HOOK_FAILED`, `PLUGIN_HOOK_BLOCKED`. All runtime errors use `KarnEvil9Error` with a code and optional data payload.

---

## 4. Kernel — Orchestration Engine

`packages/kernel/src/kernel.ts`

The kernel owns session lifecycle and coordinates all subsystems.

### Configuration

```typescript
interface KernelConfig {
  journal: Journal;
  toolRegistry: ToolRegistry;
  planner?: Planner;
  toolRuntime?: ToolRuntime;
  permissions?: PermissionEngine;
  pluginRegistry?: PluginRegistry;
  mode: ExecutionMode;
  limits: SessionLimits;
  policy: PolicyProfile;
  plannerRetries?: number;        // exponential backoff (500ms base, 15s max, jitter)
  plannerTimeoutMs?: number;
  agentic?: boolean;
  disableCritics?: boolean;
  activeMemory?: ActiveMemory;
  futilityConfig?: FutilityConfig;
  modelPricing?: ModelPricing;
  contextBudgetConfig?: ContextBudgetConfig;
  checkpointDir?: string;
}
```

### Execution Phases

**Single-shot flow:**
```
createSession(task)
  → planPhase()
      → recall relevant lessons from ActiveMemory
      → call planner.generatePlan()
      → retry with exponential backoff on failure
      → validate plan schema + run critics
      → run plugin hooks (before_plan / after_plan)
  → executePhase()
      → resolve step dependency DAG
      → execute steps in batches (max 5 concurrent)
      → for each step: validate input → check permissions → run tool → validate output → record result
      → enforce duration limits per batch
  → extract lesson → complete session
```

**Agentic flow:**
```
createSession(task)
  → agenticPhase()
      loop (up to max_iterations):
        → check duration budget
        → assess context budget (may trigger delegate / checkpoint / summarize)
        → planPhase(allowEmptySteps=true)
        → if plan.steps is empty → done (success)
        → check token / cost / step limits
        → executePhase()
        → check futility (repeated errors, stagnation, pattern loops)
        → track iteration metrics
  → extract lesson → complete session
```

### Critic System

Pre-execution validators run against every plan:

| Critic | Purpose |
|--------|---------|
| `toolInputCritic` | Validates step inputs match tool JSON schemas |
| `stepLimitCritic` | Checks cumulative step count against session limits |
| `selfReferenceCritic` | Detects circular dependency chains |
| `unknownToolCritic` | Verifies all tool references exist in registry |

Critics can be disabled via `disableCritics: true`.

### Futility Monitor

Detects unproductive agentic iterations by tracking `IterationRecord` history:
- Repeated identical errors across iterations
- Stagnation (no new progress)
- Oscillating patterns (A→B→A→B)

When futility is detected, the kernel halts with a `futility.detected` journal event.

### Context Budget Manager

Monitors cumulative token usage against budget thresholds and returns a verdict:

| Verdict | Trigger | Action |
|---------|---------|--------|
| `ok` | Below thresholds | Continue normally |
| `delegate` | Approaching limit | Spawn child kernel (subagent) with 30% of remaining budget |
| `checkpoint` | Higher threshold | Save `SessionCheckpointData` to disk |
| `summarize` | Near limit | Request context compression |

### Subagent Delegation

When the context budget verdict is `delegate`, the kernel spawns a child `Kernel` instance that:
- Inherits the parent's journal, tools, planner, and permissions
- Receives a limited budget (30% of parent's remaining)
- Has delegation disabled (no cascading subagents)
- Returns findings that are injected into the parent's next planning iteration

### Session Resumption

`resumeSession(sessionId)` rebuilds session state from journal events and continues the execution phase. Only supported for non-agentic sessions (multi-iteration state is too complex to reconstruct).

---

## 5. Journal — Immutable Event Log

`packages/journal/src/journal.ts`

Append-only JSONL file with cryptographic integrity guarantees.

**Write path:** validate event schema → assign `seq` + `hash_prev` → acquire write lock → append to file → fsync → update in-memory index → notify listeners.

**Integrity:** Each event's `hash_prev` is the SHA-256 of the preceding event's JSON. `verifyIntegrity()` replays the chain and reports the first break point.

**Session index:** In-memory `Map<sessionId, JournalEvent[]>` built on `init()` for O(1) session queries. Supports offset/limit pagination via `readSession()`.

**Compaction:** `compact(retainSessionIds)` removes events for dead sessions, rebuilds the hash chain, writes to a temp file, and atomically renames.

**Redaction:** When `redact: true` (default), payloads are scrubbed before persistence. Listeners still receive the full event.

---

## 6. Permission Engine

`packages/permissions/src/permission-engine.ts`

### Permission Format

```
domain:action:target
```

Examples: `filesystem:write:workspace`, `network:request:api.github.com`, `shell:exec:git`.

### Decision Types

| Decision | Scope | Behavior |
|----------|-------|----------|
| `allow_once` | step | Single use, not cached after step completes |
| `allow_session` | session | Valid for remaining session lifetime |
| `allow_always` | global | Persists across all sessions |
| `allow_constrained` | varies | Approval with constraints (path restrictions, duration limits, input overrides, output redaction) |
| `allow_observed` | varies | Approval with telemetry logging (`basic` or `detailed`) |
| `deny` | — | Rejected |
| `deny_with_alternative` | — | Rejected with suggested safer tool |

### Multi-Level Cache

```
Global cache ──────────── allow_always grants (persist across sessions)
    │
Session cache ─────────── allow_session grants
    │
Step-scoped ───────────── allow_once grants (cleared per step)
    │
Constraint cache ──────── allow_constrained metadata
    │
Observed cache ────────── allow_observed flags
```

### Approval Flow

1. Check caches (global → session → step)
2. If no cached grant → emit `permission.requested` journal event
3. Call user-provided `ApprovalPromptFn` callback
4. Cache decision based on scope
5. Emit `permission.granted` or `permission.denied`

---

## 7. Tool System

### Registry (`packages/tools/src/tool-registry.ts`)

In-memory store of `ToolManifest` objects. Tools are registered directly, loaded from individual YAML files, or bulk-loaded from a directory (expects `tool.yaml` in each subdirectory). `getSchemasForPlanner()` returns a stripped-down view suitable for LLM prompts.

### Runtime (`packages/tools/src/tool-runtime.ts`)

Executes tool requests through a 10-stage pipeline:

```
1. Registry lookup          → TOOL_NOT_FOUND
2. Circuit breaker check    → CIRCUIT_BREAKER_OPEN
3. Input schema validation  → INVALID_INPUT
4. Permission check         → PERMISSION_DENIED
5. Constraint application   → input overrides, policy narrowing
6. Telemetry emission       → permission.observed_execution
7. Execution with timeout   → mock returns mock_responses[0]; real calls handler
8. Output schema validation → INVALID_OUTPUT
9. Output redaction         → strip fields listed in output_redact_fields
10. Result recording        → tool.succeeded or tool.failed + circuit breaker update
```

### Circuit Breaker

Per-tool failure tracking. Opens after 5 consecutive failures, blocking further calls for 30 seconds. After cooldown, enters half-open state allowing a single retry. A success resets the breaker to closed.

### Policy Enforcer (`packages/tools/src/policy-enforcer.ts`)

Validates operations against the session's `PolicyProfile`:

| Check | Function | Details |
|-------|----------|---------|
| Path access | `assertPathAllowed()` | Prefix match against `allowed_paths` |
| Symlink safety | `assertPathAllowedReal()` | Resolves symlinks, verifies resolved path is within bounds |
| Command whitelist | `assertCommandAllowed()` | Binary name must be in `allowed_commands` |
| Endpoint whitelist | `assertEndpointAllowed()` | Hostname must be in `allowed_endpoints` |
| SSRF protection | Built-in | Blocks private IPs (RFC 1918), limits to ports 80/443/8080/8443, requires http(s) protocol |

### Built-in Handlers (`packages/tools/src/handlers/`)

| Handler | Input | Key Behavior |
|---------|-------|--------------|
| `readFileHandler` | `{path}` | Symlink resolution before read, returns `{content, exists, size_bytes}` |
| `writeFileHandler` | `{path, content}` | Validates writable_paths/readonly_paths, atomic mkdir+write, symlink check |
| `shellExecHandler` | `{command, cwd?}` | Sanitizes env vars (AWS/AZURE/GCP/OPENAI/ANTHROPIC/GITHUB tokens filtered), 60s timeout, 1MB buffer |
| `httpRequestHandler` | `{url, method, headers?, body?}` | Endpoint validation, GET/POST/PUT/DELETE |
| `browserHandler` | `{action, ...params}` | Proxies to relay server, validates navigate URLs against allowed_endpoints |

All handlers respect `ExecutionMode`: `mock` returns hardcoded responses, `dry_run` returns descriptions of what would happen, `real` executes with full policy enforcement.

---

## 8. Planner

`packages/planner/src/planner.ts`

### Implementations

| Planner | Use Case | Behavior |
|---------|----------|----------|
| `MockPlanner` | Testing | Returns deterministic plans from first available tool; empty steps in agentic mode when all prior steps succeeded |
| `LLMPlanner` | Production | Calls an LLM via `ModelCallFn` callback; supports Claude and OpenAI |
| `RouterPlanner` | Domain routing | Classifies task and delegates to domain-specific planner with filtered tool set |

### Prompt Security

The LLM planner wraps all untrusted data in delimiters to prevent prompt injection:

```
<<<UNTRUSTED_INPUT>>>
{user-provided content, tool outputs, memory lessons}
<<<END_UNTRUSTED_INPUT>>>
```

Three sanitization functions enforce this:
- `wrapUntrusted(text)` — wraps content and strips embedded delimiter strings (max 10KB)
- `sanitizeForPrompt(text)` — filters delimiter strings from interpolations (max 2KB)
- `truncateOutput(text)` — prevents token flooding (max 4KB)

### Prompt Construction

**Single-shot:** System prompt defines output schema, tool schemas, and constraints. User prompt contains task text, constraints, domain context, relevant memory lessons, and state snapshot.

**Agentic:** System prompt emphasizes the feedback loop (plan→execute→observe→replan) and limits to 1–3 steps per iteration. User prompt adds execution history from previous iterations, subagent findings, and checkpoint data for resumption. An empty steps array signals "done."

Response validation: max 500KB, strips markdown fences, validates against plan schema.

---

## 9. Plugin System

`packages/plugins/src/`

### Lifecycle

```
Discovery ──► Loading ──► Active ──► Unloaded
    │             │                      ▲
    │             ▼                      │
    │          Failed                    │
    │                            reloadPlugin()
    │                         (atomic: unload → load → restore on failure)
    └─ Scans directory for plugin.yaml manifests
```

### Manifest (`plugin.yaml`)

```yaml
id: my-plugin            # ^[a-z0-9_-]+$, 1-64 chars
name: My Plugin
version: 1.0.0
description: What it does
entry: index.js          # relative path, no ".." allowed
permissions: [...]
config_schema: {...}     # optional JSON schema for plugin config
provides:
  tools: [tool-name]
  hooks: [before_step, after_step]
  routes: [/my-endpoint]
  commands: [my-cmd]
  services: [my-service]
```

### Plugin API (`PluginApiImpl`)

Plugins receive a `PluginApi` object in their `register()` function:

| Method | Behavior |
|--------|----------|
| `registerTool(manifest, handler)` | Validates tool name against `provides.tools`, adds to ToolRegistry + ToolRuntime |
| `registerHook(name, handler, opts?)` | Validates against `provides.hooks`, default priority=100, timeout=5000ms |
| `registerRoute(method, path, handler)` | Auto-prefixes `/api/plugins/<id>/`, wraps with error isolation + 30s timeout |
| `registerCommand(name, opts)` | Validates against `provides.commands` |
| `registerPlanner(planner)` | Registers alternative planning strategy |
| `registerService(service)` | Lifecycle-managed `start()`/`stop()` with optional `healthCheck()` |

Config is frozen via `Object.freeze()` after initialization.

### Hook Runner

Hooks execute in priority order (lower number = higher priority). Each hook handler returns one of:

| Action | Effect | Availability |
|--------|--------|-------------|
| `continue` | Proceed unchanged | All hooks |
| `modify` | Replace data (merged into accumulator) | All hooks |
| `block` | Prevent execution, with reason | Only `before_*` hooks |
| `observe` | Log only, no effect | All hooks |

Safety measures:
- Per-plugin circuit breaker (5 failures → 30s cooldown)
- Timeout enforcement via `Promise.race` (default 5s)
- Data size limit: 64KB per hook result
- Deep cloning between plugins prevents reference sharing

### Hook Points

`before_session_start`, `after_session_end`, `before_plan`, `after_plan`, `before_step`, `after_step`, `before_tool_call`, `after_tool_call`, `on_error`

---

## 10. Memory System

`packages/memory/src/`

### Three Layers

| Layer | Scope | Persistence | Purpose |
|-------|-------|-------------|---------|
| **WorkingMemoryManager** | Single session | None (in-memory) | Ephemeral key-value scratch space |
| **LongTermMemory** | Single session | None (in-memory) | Bounded cache (1000 items) with FIFO eviction, substring search |
| **ActiveMemory** | Cross-session | JSONL file (`sessions/memory.jsonl`) | Lesson persistence across sessions |

### ActiveMemory — Cross-Session Learning

Stores `MemoryLesson` records extracted from completed/failed sessions:

```typescript
interface MemoryLesson {
  lesson_id: string;
  task_summary: string;    // redacted, first 200 chars
  outcome: "succeeded" | "failed";
  lesson: string;
  tool_names: string[];
  created_at: string;
  session_id: string;
  relevance_count: number; // incremented on retrieval
  last_retrieved_at?: string;
}
```

**Persistence:** Atomic writes via temp file + fsync + rename. Max 100 lessons; eviction by lowest `relevance_count` then oldest creation date. Auto-prunes lessons older than 30 days unless recently retrieved.

**Sensitive data redaction:** Strips Bearer tokens, GitHub tokens, AWS credentials, and private keys from task summaries.

**Integration with planner:** During `planPhase()`, the kernel recalls relevant lessons via `search()` and injects them into the planner's user prompt as context.

### TaskStateManager

Tracks execution state within a session: current plan reference, step results (`Map<step_id, StepResult>`), and artifacts (`Map<name, value>`). Provides `getSnapshot()` for agentic re-planning with structured metadata.

---

## 11. API Server

`packages/api/src/server.ts`

Express 5 server with optional Bearer token authentication (timing-safe comparison).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | System health (journal, tools, planner, plugins, disk) |
| `POST` | `/sessions` | Create and run session (background) |
| `GET` | `/sessions/:id` | Session snapshot |
| `POST` | `/sessions/:id/abort` | Graceful abort |
| `GET` | `/sessions/:id/journal` | Session events |
| `GET` | `/sessions/:id/stream` | **SSE** real-time event stream |
| `GET` | `/approvals` | List pending permission requests |
| `POST` | `/approvals/:id` | Submit approval decision |
| `GET` | `/tools` | List registered tools |
| `GET` | `/tools/:name` | Tool detail |
| `POST` | `/sessions/:id/replay` | Return all events for audit |
| `POST` | `/sessions/:id/recover` | Resume interrupted session |
| `GET` | `/api/journal/compact` | Compact journal retaining specified sessions |
| `GET` | `/plugins` | List plugins |
| `GET` | `/plugins/:id` | Plugin detail |
| `POST` | `/plugins/:id/reload` | Reload plugin |
| `POST` | `/plugins/:id/unload` | Unload plugin |

### SSE Streaming

`GET /sessions/:id/stream` opens a persistent connection:
- Supports catch-up replay via `Last-Event-ID` header or `after_seq` query parameter
- Backpressure handling: pauses client on write buffer full, queues up to 1000 missed events, disconnects if queue overflows
- 15-second keepalive heartbeat
- Max 10 concurrent SSE clients per session

### Approval Workflow

When a tool requires a permission the user hasn't pre-granted:
1. PermissionEngine calls its `ApprovalPromptFn`
2. API stores the pending request in-memory
3. SSE broadcasts `permission.requested` to connected clients
4. Client submits decision via `POST /approvals/:id`
5. Callback resolves, execution continues

---

## 12. CLI

`packages/cli/src/index.ts`

| Command | Description |
|---------|-------------|
| `karnevil9 run <task>` | Execute task end-to-end. Options: `--mode`, `--max-steps`, `--planner`, `--model`, `--plugins-dir`, `--agentic`, `--context-budget`, `--checkpoint-dir`, `--no-memory` |
| `karnevil9 plan <task>` | Generate plan without execution |
| `karnevil9 tools list` | List registered tools |
| `karnevil9 session ls` | List sessions from journal |
| `karnevil9 session watch <id>` | Real-time event tail |
| `karnevil9 replay <id>` | Replay session with integrity verification |
| `karnevil9 server` | Start API server. Options: `--port`, `--planner`, `--model`, `--agentic`, `--no-memory` |
| `karnevil9 relay` | Start browser relay. Options: `--port`, `--driver` (managed/extension), `--no-headless` |
| `karnevil9 plugins list/info/reload` | Plugin management |

Interactive approval prompt offers: **[a]**llow once, **[s]**ession, **[g]**lobal, **[d]**eny, **[c]**onstrained, **[o]**bserved.

---

## 13. Browser Relay

`packages/browser-relay/src/`

HTTP server abstracting browser automation behind a driver interface.

### Drivers

| Driver | Backend | Communication |
|--------|---------|--------------|
| `ManagedDriver` | Playwright (optional dep) | Direct process control |
| `ExtensionDriver` | Browser extension | WebSocket bridge |

### Actions

`navigate`, `snapshot` (accessibility tree), `click`, `fill`, `select`, `hover`, `keyboard`, `screenshot`, `get_text`, `evaluate` (JS), `wait`.

Targets are resolved by ARIA role, text content, CSS selector, placeholder, label, or ordinal position.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Driver status, uptime |
| `POST` | `/actions` | Execute browser action |
| `POST` | `/close` | Gracefully close browser |

---

## 14. Security Architecture

### Defense in Depth

```
Layer 1: Input Validation       JSON schema validation (AJV) at all component boundaries
Layer 2: Permission Engine      domain:action:target grants with multi-level caching
Layer 3: Policy Enforcer        Path allowlisting, SSRF protection, command filtering
Layer 4: Prompt Injection       Untrusted data delimiters in LLM prompts
Layer 5: Plugin Sandboxing      Manifest validation, timeout protection, directory bounds
Layer 6: Journal Integrity      SHA-256 hash chain for tamper detection
Layer 7: Data Redaction         Payload redaction in journal, credential filtering in shell env
Layer 8: Circuit Breaker        Prevents cascading tool failures
```

### SSRF Protection (always applied, independent of endpoint allowlist)

- Protocol whitelist: `http:` and `https:` only
- Blocked IP ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0`, `fc00::/7`
- Port whitelist: 80, 443, 8080, 8443

### Environment Variable Sanitization (shell handler)

Filters all env vars with prefixes: `AWS_`, `AZURE_`, `GCP_`, `GOOGLE_`, `OPENAI_`, `ANTHROPIC_`, `GITHUB_`, `GITLAB_` and suffixes: `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `API_KEY`, `PRIVATE_KEY`.

---

## 15. Validation

All schemas use AJV with `strict: false` and `ajv-formats`. Six validators are exported from `@karnevil9/schemas`:

| Validator | Used By |
|-----------|---------|
| `validatePlanData` | Kernel (after planner returns) |
| `validateToolManifestData` | ToolRegistry (on registration) |
| `validateJournalEventData` | Journal (before every write) |
| `validatePluginManifestData` | Plugin discovery |
| `validateToolInput` | ToolRuntime (pre-execution) |
| `validateToolOutput` | ToolRuntime (post-execution) |

All return `{ valid: boolean; errors: string[] }` with paths formatted as `${instancePath}: ${message}`.

---

## 16. Key Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| **State Machine** | Kernel (session status) | Enforces valid status transitions |
| **Strategy** | Planner (Mock/LLM/Router) | Pluggable plan generation |
| **Observer** | Journal (listeners) | Decoupled real-time event consumption |
| **Chain of Responsibility** | Hook runner | Sequential plugin hook execution with blocking |
| **Circuit Breaker** | ToolRuntime, HookRunner | Resilience against cascading failures |
| **Facade** | Kernel | Hides subsystem complexity behind `run()` |
| **Factory** | ToolRegistry | Tool manifest loading from files/directories |
| **DAG Executor** | Kernel (executePhase) | Dependency-ordered batch step execution |
| **Hierarchical Delegation** | Kernel (subagent) | Parent-child kernel spawning for budget management |

---

## 17. Runtime File Layout

```
sessions/
├── memory.jsonl             ← ActiveMemory lessons (cross-session)
└── checkpoints/             ← SessionCheckpointData files (agentic mode)

journal/
└── events.jsonl             ← Append-only event log with hash chain

plugins/
└── example-logger/
    ├── plugin.yaml          ← Manifest
    └── index.js             ← register(api) entry point

tools/
└── examples/
    ├── read-file/tool.yaml
    ├── write-file/tool.yaml
    ├── shell-exec/tool.yaml
    ├── http-request/tool.yaml
    └── browser/tool.yaml
```
