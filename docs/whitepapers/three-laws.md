# The Three Laws of Safe AI Agents

## How KarnEvil9 Implements Asimov's Framework as Runtime-Enforced Guardrails

**KarnEvil9 Project:** https://github.com/oldeucryptoboi/KarnEvil9 | **Revised:** February 26, 2026

---

> *"A robot may not injure a human being or, through inaction, allow a human being to come to harm."*
> - Isaac Asimov, *I, Robot* (1950)

---

## Abstract

On February 24, 2026, Anthropic released Responsible Scaling Policy (RSP) Version 3.0 and published accompanying materials describing Frontier Safety Roadmaps and periodic Risk Reports as a central transparency mechanism. Reporting the same week described Anthropic removing a prior pledge that conditioned training or release on guaranteed mitigations in advance, and reframing how and when it might delay development in response to catastrophic-risk concerns.

This paper does not argue against safety policies. Instead, it argues that the most safety-critical guardrails for tool-using AI agents should be implemented as runtime-enforced invariants in the orchestration layer that mediates between a model (planner) and external tools (filesystem, network, shell, browser). Runtime guardrails are not immutable. A vendor can ship a new runtime, and a deployer can change configuration. The claim is narrower and more practical: guardrails in code create explicit, testable, auditable change surfaces, and can be pinned, regression-tested, and independently monitored in ways that high-level policy language often cannot.

We use Isaac Asimov's Three Laws of Robotics as an organizing hierarchy because the ordering maps cleanly onto agent runtime design:

1. Prevent runtime-detectable harms to the user and their environment.
2. Obey the user, subject to Law 1.
3. Preserve availability and resources, subject to Laws 1 and 2.

We show how KarnEvil9 implements this hierarchy with typed tools, permission gates, policy enforcement, SSRF defenses (including DNS resolution and redirect hop validation), sensitive file blocks, secret redaction at multiple boundaries, plan critics, and resource protection (circuit breakers, futility detection, budgets, checkpoints). We also discuss "Zeroth Law" constraints in multi-agent settings (graduated authority, delegation firebreaks, reversibility policies).

To support peer review, this revision adds: a threat model and scope section, explicit limitations for each major safeguard, a more careful treatment of durability and journaling guarantees, a clarified hardening arc narrative, and an evaluation matrix that ties controls to threats and test coverage.

---

## Table of Contents

1. [The Problem: Safety as Policy vs Safety as Runtime Guardrails](#1-the-problem-safety-as-policy-vs-safety-as-runtime-guardrails)
2. [Threat Model and Scope](#2-threat-model-and-scope)
3. [The Three Laws, Operationalized for Agent Runtimes](#3-the-three-laws-operationalized-for-agent-runtimes)
4. [First Law: Prevent Runtime-Detectable Harm](#4-first-law-prevent-runtime-detectable-harm)
5. [Second Law: Obey the User Within First-Law Bounds](#5-second-law-obey-the-user-within-first-law-bounds)
6. [Third Law: Preserve Availability and Resources](#6-third-law-preserve-availability-and-resources)
7. [Evaluation: Scenarios, Coverage, and Overhead](#7-evaluation-scenarios-coverage-and-overhead)
8. [The Hardening Arc](#8-the-hardening-arc)
9. [The Zeroth Law Problem](#9-the-zeroth-law-problem)
10. [Conclusion](#10-conclusion)
11. [Appendix A: Selected Design Dialogues](#appendix-a-selected-design-dialogues)
12. [Appendix B: Making Runtime Guardrails Durable](#appendix-b-making-runtime-guardrails-durable)
13. [References](#references)

---

## 1. The Problem: Safety as Policy vs Safety as Runtime Guardrails

In 2026, "frontier safety" is often communicated through policy-level frameworks: Anthropic's Responsible Scaling Policy, OpenAI's Preparedness Framework, and Google DeepMind's Frontier Safety Framework. These documents matter because they define risk categories, evaluation expectations, and escalation triggers. They are also vulnerable to the same thing every voluntary governance mechanism is vulnerable to: shifting incentives, shifting leadership, and shifting interpretations.

This paper focuses on a different question: when an AI system is deployed as a tool-using agent, where should the most safety-critical controls live?

KarnEvil9 treats the agent runtime as the enforcement chokepoint between a model that proposes actions and the tools that can actually cause irreversible effects. By designing the runtime as a narrow waist, every filesystem read, network request, shell command, and browser action becomes enforceable by code before it is executed.

### 1.1 A narrower, defensible claim about "safety as code"

It is tempting to claim that code-based guardrails "cannot be revised by press release." That is rhetorically satisfying but technically incorrect. Code can be changed quickly, especially in centrally deployed services.

The practical claim is:

- Runtime guardrails require a concrete change (diffs, tests, release artifacts) to weaken.
- Those changes can be reviewed, logged, and monitored.
- Deployers can pin versions and run safety regression suites to detect weakening.
- Independent monitoring is feasible when enforcement is implemented as an explicit, observable boundary.

Appendix B lists operational practices that make this durability real (signed releases, pinned versions, changelogs, safety regression tests, and external transparency logs).

### 1.2 Why the runtime boundary matters for agent safety

Model-level safety training is valuable, but agent risk frequently comes from the transformation of text into actions. Prompt injection is not just a content problem; it becomes a systems problem when injected text can route into tools.

A runtime policy enforcer does not need to infer intent or morality. It can enforce invariants:

- "This file category is always blocked."
- "This endpoint class is always blocked."
- "This command family requires explicit opt-in."
- "This output channel is redacted before persistence."

This is the design space this paper explores.

---

## 2. Threat Model and Scope

This section makes explicit what KarnEvil9 is trying to defend against, what assets it protects, and what it is not designed to solve.

### 2.1 Agents and trust boundaries

We assume an agent architecture with:

- **Planner:** an LLM that produces a plan (steps, tools, inputs, dependencies).
- **Runtime:** deterministic execution that validates and runs plan steps through tool handlers.
- **Tools:** filesystem, network, shell, browser, and other plugins.

We treat the planner output as untrusted input. The runtime is the enforcement boundary.

### 2.2 Adversaries and failure modes

**Primary adversaries:**

1. **Malicious user** attempting to coerce unsafe behavior (exfiltration, destruction, SSRF).
2. **Prompt injection from untrusted content** (web pages, documents, tool outputs) that manipulates the planner.
3. **Compromised or malicious plugin/tool** returning crafted outputs or attempting unauthorized actions.
4. **Accidental model error** (hallucinated tools, malformed plans, loops, unsafe commands).
5. **Multi-agent propagation** (delegation chains that amplify mistakes or malice).

### 2.3 Assets and security goals

**Assets to protect:**

- **Secrets:** API keys, credentials, tokens, private keys, cookies, environment variables.
- **Filesystem integrity:** prevent unauthorized read/write, prevent traversal and symlink escape.
- **Network boundaries:** prevent SSRF into private ranges and metadata endpoints, prevent redirect-based bypasses.
- **Operational budgets:** prevent runaway token/cost/time consumption.
- **Auditability:** maintain a tamper-evident record of requests, permissions, and actions.

### 2.4 Out of scope

KarnEvil9 is not a complete solution for:

- **Human harm that is not mediated by tools** (misinformation, persuasion, advice).
- **Physical-world harm** unless the runtime controls physical actuators (not covered here).
- **Model alignment** in the broad sense (value learning, deception, long-horizon planning risks).
- **Perfect secrecy guarantees**: redaction reduces risk; it is not a proof of non-leakage.
- **Full sandboxing**: command filtering is not equivalent to OS-level isolation.

### 2.5 Mapping threats to the Three Laws

| Threat class | Example | Primary assets | Law priority | Representative controls |
|---|---|---|---|---|
| Secret exfiltration | prompt injects "print env" | secrets, audit logs | 1 | sensitive file blocks, env sanitization, output redaction, journal redaction |
| SSRF | fetch redirects to metadata IP | network boundary, secrets | 1 | endpoint allowlists, private-range blocks, DNS resolution checks, redirect hop validation |
| Filesystem escape | symlink inside workspace -> /etc | filesystem, secrets | 1 | realpath checks, allowed-path enforcement, write mutexes |
| Destructive commands | rm -rf, find -delete | filesystem | 1 | command allowlists, dangerous-flag blocks, permission prompts |
| Planner failures | cycles, unknown tools | availability, correctness | 2 then 3 | critics, schema validation, tool registry checks |
| Resource exhaustion | infinite planning loop | budgets, availability | 3 | futility monitor, circuit breaker, session limits, checkpoints |
| Swarm risk | runaway delegation | ecosystem | 0 | graduated authority, liability firebreaks, reversibility policy |

---

## 3. The Three Laws, Operationalized for Agent Runtimes

Asimov's Three Laws are a storytelling device, not a formal spec. This paper uses them only as a hierarchy that matches runtime design priorities.

### 3.1 Operational definition of "harm"

In this paper, **"harm"** is intentionally narrowed to harms that are:

- **Measurable or enforceable at runtime**, and
- **Downstream of tool use**.

Examples include credential leakage into logs, unauthorized filesystem access, SSRF into private networks, destructive commands, and runaway resource burn that harms availability or budgets.

This is not a claim that these are the only harms that matter. It is a claim about what a runtime can reliably enforce without having to solve general moral reasoning.

### 3.2 The Laws, restated

**First Law (operational):** the runtime must prevent tool actions that create unauthorized, runtime-detectable harm to the user's data, credentials, infrastructure, or environment.

**Second Law (operational):** the runtime should execute user intent faithfully through the planner's plan, except when doing so would violate the First Law.

**Third Law (operational):** the runtime should preserve availability and resources (time, tokens, cost, system stability), except when doing so would violate the First or Second Law.

The hierarchy is strict: **First > Second > Third**.

---

## 4. First Law: Prevent Runtime-Detectable Harm

The First Law is implemented primarily through the policy enforcement layer and tool handlers. The runtime treats every tool call as untrusted until validated.

### 4.1 Sensitive file blocking

Some files should never be read or written by an agent, regardless of user request or planner output.

KarnEvil9 implements a non-configurable defense-in-depth blocklist for common secret file names, sensitive extensions, and secret directories.

```typescript
const SENSITIVE_BASENAMES = new Set([
  ".env", "credentials.json", "service-account.json",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
]);

const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws"];

/**
 * Defense-in-depth: blocks reads/writes to files that are very likely secrets.
 * Not configurable: this safety net applies regardless of policy allowlists.
 */
export function assertNotSensitiveFile(targetPath: string): void {
  const resolved = resolve(targetPath);
  const segments = resolved.split("/");
  const basename = segments[segments.length - 1] ?? "";

  if (SENSITIVE_BASENAMES.has(basename)) {
    throw new PolicyViolationError(
      `Access to sensitive file "${basename}" is blocked`
    );
  }

  if (/^\.env\..+$/.test(basename)) {
    throw new PolicyViolationError(
      `Access to sensitive file "${basename}" is blocked`
    );
  }

  // Extension + directory checks follow...
}


### 4.5.1 Tamper-evident journaling (and what it does not guarantee)

KarnEvil9's journal is designed to support accountability and post-incident analysis. Conceptually, it is an append-only JSONL event stream where each record can include integrity metadata (for example, a SHA-256 hash-chain link to the previous record). A hash chain is **tamper-evident**: if an attacker edits or deletes events, the chain can be detected as broken.

A hash chain is not automatically "immutable." If you need immutability against a powerful actor who controls storage, you also need external anchoring, such as signing log segments with a key whose public component is published, writing hashes to a transparency log, or using WORM-style storage. See Appendix B for durability practices.

```

**Limitations and future work:**

- The example uses POSIX-style path splitting (`split("/")`). Cross-platform support should use `path.parse`, `path.sep`, and `path.relative`, and must be tested on Windows.
- This is a heuristic list. It should be complemented by deployer-specific secret mounts and OS-level secret management.

### 4.2 SSRF protection and endpoint validation

SSRF is a high-impact failure mode for agent runtimes because it turns "make a request" into "probe internal infrastructure."

KarnEvil9 uses a two-tier strategy:

1. Synchronous validation: protocol, hostname, port allow rules and private-range blocks.
2. Asynchronous validation: DNS resolution checks to reduce DNS rebinding risk.

```typescript
export function assertEndpointAllowed(url: string, allowedEndpoints: string[]): void {
  // ...
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfError(`Protocol "${parsed.protocol}" is not allowed.`);
  }
  if (isPrivateIP(parsed.hostname)) {
    throw new SsrfError(`Requests to private/reserved IP "${parsed.hostname}" are blocked.`);
  }
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw new SsrfError(`Port ${port} is not allowed.`);
  }
}

export async function assertEndpointAllowedAsync(url: string, allowedEndpoints: string[]): Promise<void> {
  assertEndpointAllowed(url, allowedEndpoints);
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const result = await lookup(hostname, { all: true });
  for (const entry of result) {
    if (isPrivateIP(entry.address)) {
      throw new SsrfError(
        `DNS rebinding detected: "${hostname}" resolves to private IP ${entry.address}`
      );
    }
  }
}
```

KarnEvil9 also validates redirect chains manually and re-runs SSRF validation at every hop.

```typescript
const MAX_REDIRECTS = 5;

for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount++) {
  if (response.status < 300 || response.status >= 400) break;

  const location = response.headers.get("location");
  if (!location) break;

  const redirectUrl = new URL(location, url).href;

  // Re-validate SSRF at every hop
  await assertEndpointAllowedAsync(redirectUrl, policy.allowed_endpoints);

  response = await fetch(redirectUrl, { ...fetchOpts, redirect: "manual" });
}
```

**Limitations and future work:**

- URL validation is notoriously bypassable (odd encodings, IPv6 edge cases, parser differentials). Runtime checks reduce risk but should be paired with egress firewall rules and VPC-level restrictions.
- DNS rebinding is mitigated but not eliminated unless the runtime pins the resolved IP and uses it for the actual connection (or controls the networking stack).
- Redirect limits prevent infinite loops but can still allow long chains that increase cost; consider per-hop budget accounting.

### 4.3 Path traversal and symlink defenses

String-based allowlists can be bypassed with symlinks. KarnEvil9 resolves symlinks via `realpath` before checking allowed paths.

```typescript
export async function assertPathAllowedReal(
  targetPath: string,
  allowedPaths: string[]
): Promise<void> {
  if (allowedPaths.length === 0) return;

  const resolved = await resolveReal(targetPath);
  const allowed = await Promise.all(
    allowedPaths.map(async (p) => {
      const resolvedAllowed = await resolveReal(p);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + "/");
    })
  );

  if (!allowed.some(Boolean)) {
    throw new PolicyViolationError(
      `Path "${resolved}" is outside allowed paths (symlink-resolved)`
    );
  }
}
```

**Limitations and future work:**

- TOCTOU remains possible when validation and access are separated in time. Stronger defenses use file descriptors and OS primitives (`openat` patterns) or run inside a constrained filesystem sandbox.
- Cross-platform path handling requires careful normalization and testing.

### 4.4 Command execution gating

Shell execution is high risk. KarnEvil9 combines:

- A command allowlist.
- A dangerous-flag denylist for high-risk binaries.
- Quote-aware argument parsing to reduce simple bypasses.

```typescript
const DANGEROUS_FLAGS: Record<string, string[]> = {
  find: ["-delete", "-exec", "-execdir", "-ok", "-okdir"],
  sed: ["-i", "--in-place"],
  rm: ["-r", "-rf", "-fr", "--recursive", "--force"],
  chmod: ["-R", "--recursive"],
  chown: ["-R", "--recursive"],
  xargs: ["-I", "--replace"],
};

export function assertCommandAllowed(command: string, allowedCommands: string[]): void {
  if (allowedCommands.length === 0) return;

  const parts = parseCommandForPolicy(command.trim());
  const binary = parts[0]!;

  if (!allowedCommands.includes(binary)) {
    throw new PolicyViolationError(`Command "${binary}" is not in allowed commands`);
  }

  const dangerous = DANGEROUS_FLAGS[binary];
  if (!dangerous) return;

  for (const arg of parts.slice(1)) {
    if (dangerous.includes(arg)) {
      throw new PolicyViolationError(`Dangerous flag "${arg}" is not allowed for "${binary}"`);
    }
  }
}
```

**Limitations and future work:**

- This is not a sandbox. If powerful interpreters are allowlisted, they can still perform destructive actions.
- Use defense in depth: least-privilege users, containers, MAC policies, seccomp profiles, and explicit volume mounts.
- Consider shifting from denylist to capability-based APIs for common safe operations (copy, grep, parse) rather than raw shell.

### 4.5 Secret redaction at multiple boundaries

Secret leakage often occurs through tool outputs and logs. KarnEvil9 applies redaction:

1. On tool stdout/stderr.
2. At the journal boundary, recursively redacting payload values and sensitive keys.

```typescript
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /xoxb-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9]{36,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9_.\-\/+=]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  // ... plus GitLab, npm, PyPI, PEM markers, and more
];
```

```typescript
const SENSITIVE_KEYS = /^(authorization|password|secret|token|api[_-]?key|credential|
  private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|
  connection[_-]?string|database[_-]?url)$/i;

export function redactPayload(value: unknown): unknown {
  if (typeof value === "string" && SENSITIVE_VALUES.test(value)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redactPayload);

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(k) && typeof v === "string") {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactPayload(v);
      }
    }
    return result;
  }

  return value;
}
```

**Limitations and future work:**

- Redaction is best-effort. It can miss transformed secrets (base64, chunking, indirect references).
- Prefer tool-level minimization (do not return secrets) and avoid logging sensitive tool outputs in the first place.
- Add tests for common transformations and structured secret patterns.

### 4.6 Browser "evaluate" gating and additional tool hardening

Executing arbitrary JavaScript through a browser tool's "evaluate" action is equivalent to running untrusted code in a sensitive context. KarnEvil9 requires explicit opt-in for this action through policy.

```typescript
if (action === "evaluate") {
  if (!policy.allowed_commands.includes("browser_evaluate")) {
    return {
      success: false,
      error: 'browser "evaluate" requires "browser_evaluate" in allowed_commands'
    };
  }
}
```

**Limitations and future work:**

- This reduces accidental use, but does not make "evaluate" safe. When enabled, it should require higher-friction permissions and additional auditing.
- Browser tools still create risks through downloads, file prompts, and credentialed sessions. Consider hardened browser profiles and isolated execution.

### 4.7 First Law summary: what is enforced vs what is merely encouraged

The First Law mechanisms above are enforcement points, not guidelines. They fail closed: they throw errors, block, or redact, rather than advising the planner to behave.

At the same time, the system is not claiming perfect safety. It is claiming that common, high-impact, runtime-detectable harms are blocked by default and require explicit policy changes to permit.

---

## 5. Second Law: Obey the User Within First-Law Bounds

The Second Law is implemented by making user intent explicit and by ensuring that the planner's plan is structurally valid before execution.

### 5.1 Permission gate and scoped approvals

Every consequential tool execution passes through a `PermissionEngine` that can require explicit user approval, and can scope approvals to:

- step
- session
- constrained grants (readonly paths, input overrides, time limits)



KarnEvil9 supports multiple decision types with explicit scope, which helps reduce repeated prompts without accumulating unlimited privilege:

| Decision | Scope | Intended behavior |
|---|---|---|
| `allow_once` | step | expires after the current step |
| `allow_session` | session | persists for the current session only |
| `allow_always` | session (deliberately) | treated as "always for this session", not process-wide |
| `allow_constrained` | step | allows with constraints like `readonly_paths`, `input_overrides`, and time limits |
| `allow_observed` | step | allows while emitting additional telemetry for review |
| `deny` | immediate | blocks execution and is recorded in the journal |

The engine also serializes prompts to avoid duplicate concurrent approvals.

```typescript
async check(request: PermissionRequest): Promise<PermissionCheckResult> {
  // Check cached grants
  for (const perm of request.permissions) {
    if (!this.isGranted(perm.scope, sessionId)) missing.push(perm);
  }
  if (missing.length === 0) return { allowed: true };

  // Serialize prompts per session
  const releaseLock = await this.acquirePromptLock(sessionId);

  // Re-check after acquiring lock
  const stillMissing = missing.filter((p) => !this.isGranted(p.scope, sessionId));
  if (stillMissing.length === 0) { releaseLock(); return { allowed: true }; }

  // Emit to journal, prompt user, apply decision
  // ...
}
```

### 5.2 Plan validation via critics

Before execution, a plan is checked by critics that enforce structural validity:

- tool inputs present and typed
- step limits enforced
- dependency cycles rejected
- unknown tools rejected

These checks prevent the runtime from "obediently" executing malformed or unsafe plans.



### 5.2.1 Policy enforcement is outside the planner

A key architectural choice is that the policy profile that constrains tools is enforced by the runtime, not negotiated by the planner. The planner can propose a step (for example, "read this file" or "fetch this URL"), but the runtime decides whether it is permitted under the active policy.

In practical terms:

- The policy is injected into the Kernel/ToolRuntime at construction time.
- Tools receive policy constraints from the runtime, not from the model.
- Plugins may be able to transform step inputs, but should not be able to mutate the policy object itself.

This separation makes "First Law overrides Second Law" an architectural property, not a behavior you hope the model will follow.

### 5.3 Hook-based policy extensions

Plugins can register hooks at lifecycle points (`before_*`, `after_*`). Selected hooks are blockable: they can halt execution with a reason. Hooks are sandboxed (timeouts, size limits) and guarded with circuit breakers so that misbehaving plugins do not crash the runtime.

### 5.4 Second Law limitations and future work

- Permission prompts protect the user only if prompts are clear and cannot be spoofed by untrusted content. UI work matters.
- Constrained permissions should become the default for high-risk actions, but require careful design to avoid user fatigue.
- Plans should include provenance annotations so the runtime can detect and quarantine steps derived from untrusted content.

---

## 6. Third Law: Preserve Availability and Resources

The Third Law prevents runaway costs and cascading failures. These mechanisms must yield to user aborts (Second Law) and must not trade secrecy for persistence (First Law).

### 6.1 Circuit breaker

A circuit breaker prevents repeated calls to a failing tool from consuming unlimited budgets.

```typescript
export class CircuitBreaker {
  private failures = new Map<string, { count: number; trippedAt: number }>();
  private threshold: number;   // default: 5
  private cooldownMs: number;  // default: 30000

  isOpen(toolName: string): boolean {
    const state = this.failures.get(toolName);
    if (!state || state.count < this.threshold) return false;

    const elapsed = Date.now() - state.trippedAt;
    if (elapsed >= this.cooldownMs) {
      state.trippedAt = Date.now();
      return false;
    }
    return true;
  }
}
```

### 6.2 Futility detection

A futility monitor halts agentic loops that are not making progress using multiple strategies:

- repeated errors
- stagnation (no new successful steps)
- identical or near-identical plans
- cost without progress
- burn-rate thresholds

### 6.3 Session limits and context budget monitoring

Hard limits prevent unbounded runtime consumption:

- wall-clock duration
- total tokens
- cost in USD
- steps and iterations

Context budget monitoring adds graduated behavior: delegate, checkpoint, summarize-and-halt based on thresholds and burn-rate projection.



KarnEvil9's context budget monitoring can be implemented with tiered thresholds, for example:

- **70%** context usage: consider delegation (especially when high-output tools like browser or HTTP are active)
- **85%** context usage: checkpoint
- **90%** context usage: summarize and halt gracefully

A representative implementation pattern:

```typescript
recordIteration(iter: ContextIteration): ContextBudgetVerdict {
  const fraction = iter.cumulativeTokens / iter.maxTokens;

  if (fraction >= this.summarizeThreshold) {
    return { action: "summarize", reason: `Token usage at ${pct}%` };
  }

  if (fraction >= this.checkpointThreshold && this.enableCheckpoint) {
    return { action: "checkpoint", reason: `Token usage at ${pct}%` };
  }

  if (fraction >= this.delegateThreshold && hasHighBurn && this.enableDelegation) {
    return { action: "delegate", reason: `Token usage at ${pct}% with high-burn tools` };
  }

  return { action: "continue" };
}
```

### 6.4 Checkpointing and recovery

Checkpoints preserve progress for resumption without requiring unsafe persistence of secrets. Payloads should be redacted before checkpointing for First Law compliance.

### 6.5 Abort semantics: Second Law overrides Third

When the user requests an abort, the runtime stops scheduling new work immediately. This is a direct implementation of the Law hierarchy.

### 6.6 Third Law limitations and future work

- Futility detection can trigger false positives. Systems should allow the user to override halts safely.
- Budget monitoring requires accurate accounting of tool costs and tokens; discrepancies should fail safe.

---

## 7. Evaluation: Scenarios, Coverage, and Overhead

This section outlines how to evaluate whether the Laws are actually enforced.

### 7.1 Scenario matrix

| Scenario | Example attempt | Expected runtime outcome | Primary safeguard(s) |
|---|---|---|---|
| Read local secrets | read `.env` | blocked | sensitive file block; journal redaction |
| SSRF to metadata | fetch 169.254.169.254 | blocked | private-range blocks; DNS checks |
| DNS rebinding | hostname resolves to 127.0.0.1 | blocked | async endpoint validation |
| Redirect-based SSRF | allowed URL redirects to private IP | blocked | redirect hop re-validation |
| Symlink escape | workspace link -> `/etc/passwd` | blocked | realpath allow checks |
| Destructive rm | `rm -rf` | blocked or permissioned | dangerous flags; permission gate |
| Planner cycle | A depends on B depends on A | rejected | dependency-cycle critic |
| Tool hallucination | call unknown tool | rejected | unknown-tool critic |
| Runaway loop | repeats plan with no progress | halted | futility detection; session limits |
| Flapping tool | tool fails repeatedly | halted or delayed | circuit breaker |

### 7.2 Test suite and what "2,574 tests" means

KarnEvil9 reports a test suite of 2,574 test cases across packages. For peer review, the relevant requirement is not the raw number; it is traceability:

- Which threat scenarios have regression tests?
- Which are integration-tested end to end?
- Which require manual red-team testing?

A minimal publishable evaluation should include:

1. A mapping from each scenario in Section 7.1 to concrete tests.
2. An adversarial prompt-injection harness that attempts to route tool output into unsafe actions.
3. A set of SSRF bypass regression tests (odd encodings, IPv6, redirects, DNS rebinding).

### 7.3 Overhead considerations

Runtime guardrails impose costs:

- DNS lookups for async endpoint validation.
- Filesystem `realpath` operations for symlink defense.
- Regex scans for output and journal redaction.
- Additional prompts and journaling overhead.

Rather than guessing, systems should measure:

- end-to-end latency per tool call with and without enforcement
- worst-case overhead under adversarial inputs
- failure-mode latency (timeouts, retries)

---

## 8. The Hardening Arc

KarnEvil9 describes eight rounds of adversarial hardening that progressively strengthened Law enforcement.

To avoid overstating evidence, this revision distinguishes between:

- **Grouped rounds (1 to 5):** collections of commits that established baseline coverage and early safeguards.
- **Pinned rounds (6 to 8):** rounds with representative commits referenced explicitly.

| Round | Representative commit | Focus | Laws strengthened | Notes |
|---|---|---|---|---|
| 1 | (grouped) | baseline unit coverage | 2, 3 | pre-tag grouping |
| 2 | (grouped) | error handling, cleanup, circuit breakers | 3 | pre-tag grouping |
| 3 | (grouped) | futility detection, sensitive files, redaction | 1, 3 | pre-tag grouping |
| 4 | (grouped) | shell output redaction, env sanitization | 1 | pre-tag grouping |
| 5 | (grouped) | symlink traversal, plan correctness | 1, 2 | pre-tag grouping |
| 6 | 8d1eef0 | permission serialization, integrity work | 1, 2 | representative |
| 7 | 7ab0f29 | SSRF hardening, concurrency fixes | 1, 3 | representative |
| 8 | 53c339c | quote bypass fixes, browser evaluate gate, redirect validation | 1 | representative |

**Future work for reproducibility:**

- Tag each hardening round in the repository so that the table can be verified mechanically.
- Publish a red-team harness and a failure corpus as part of the evaluation section.

---

## 9. The Zeroth Law Problem

Asimov's "Zeroth Law" expands safety from an individual to a population: do not harm humanity.

In agent runtimes, this generalizes to ecosystem safety in multi-agent settings:

- prevent runaway delegation chains
- limit low-trust agents
- escalate irreversible, high-criticality tasks to humans

KarnEvil9's swarm-oriented components include:

- **Graduated authority:** budgets and monitoring based on trust scores.
- **Liability firebreaks:** bounded delegation chain depth, tightened for low reversibility tasks.
- **Reversibility policy:** human escalation for high-criticality, low-reversibility actions; quarantine on detected malicious behavior.

The Zeroth Law remains an open design space because it requires reasoning about aggregate welfare and systemic risk, not just per-user harms.

---

## 10. Conclusion

Safety policies and model-level mitigations are important, but they are not sufficient for tool-using agents operating in adversarial environments.

KarnEvil9 illustrates a runtime-centered approach:

- **First Law:** enforce invariants on tools (files, network, shell, browser) and reduce secret persistence through layered redaction.
- **Second Law:** make obedience explicit via typed plans, critics, and permission gating.
- **Third Law:** prevent runaway loops and failures via budgets, circuit breakers, and futility detection.
- **Zeroth Law:** constrain multi-agent propagation through graduated authority and delegation firebreaks.

The strongest version of "safety as code" is not the claim that code cannot change. It is the claim that safety-critical weakening should be difficult to do quietly: it should require an explicit release, and it should be detectable by downstream users who pin versions and run regression suites.

---

## Appendix A: Selected Design Dialogues

This appendix contains selected design dialogues from adversarial hardening rounds. They are moved here to keep the main narrative paper-like while retaining engineering provenance and context.

> **User** `round 3`
>
> what happens if the planner generates a step that reads .env?
>
> **EDDIE**
>
> Currently nothing stops it. `readFileHandler` checks `assertPathAllowed` against the
> allowlist, but `.env` is inside the working directory, so it passes. The file contents
> would flow into the step result, into the journal, and potentially into the planner's
> next context window. That's a credential leak across three layers.
>
> **User**
>
> fix it. make it non-configurable.
>
> **EDDIE**
>
> Adding `assertNotSensitiveFile()` as a defense-in-depth check. It's not policy-dependent
> - it fires regardless of the allowlist. Blocking: `.env`, `.env.*`, credential files,
> private keys, and anything under `.ssh/`, `.gnupg/`, or `.aws/`.

---

> **User** `round 7, commit 7ab0f29`
>
> check if the http handler validates endpoints after DNS resolution. hostname could
> resolve to 127.0.0.1.
>
> **EDDIE**
>
> It doesn't. `assertEndpointAllowed` checks the hostname string against private IP
> patterns, but `evil.com` could have an A record pointing to `127.0.0.1`. Classic DNS
> rebinding attack.
>
> **User**
>
> add an async variant that resolves first.
>
> **EDDIE**
>
> Adding `assertEndpointAllowedAsync()`. It runs the synchronous checks first, then
> resolves the hostname via `dns.lookup()` and re-validates every resolved IP. Also adding
> the CGNAT range `100.64.0.0/10` - RFC 6598 shared address space that we were missing.

---

> **User** `round 5`
>
> what if someone plants a symlink? `workspace/evil -> /etc/passwd`
>
> **EDDIE**
>
> `assertPathAllowed` uses `path.resolve()` which doesn't follow symlinks - it just
> normalizes the string. The symlink is inside `workspace/`, so it passes. Then `readFile`
> follows the symlink and reads `/etc/passwd`.
>
> Adding `assertPathAllowedReal()` - resolves symlinks via `fs.realpath()` before
> checking the allowlist. For non-existent targets (write operations), it resolves the
> closest existing ancestor to detect symlinks in the parent chain. 5-second timeout
> to prevent hangs on broken symlinks.

---

> **User** `round 8, commit 53c339c`
>
> can you bypass the dangerous flag check with quotes? like `rm "-rf" /tmp`
>
> **EDDIE**
>
> Testing... yes. The parser was splitting on spaces but not handling quoted arguments.
> `"-rf"` is passed as a single token including the quotes, so it doesn't match the
> string `"-rf"` in the dangerous flags list. The quotes defeat the check.
>
> **User**
>
> fix it.
>
> **EDDIE**
>
> Replacing the naive `split(" ")` with a quote-aware parser that handles double quotes,
> single quotes, and backslash escaping - matching the same parser `shell-exec` uses.
> Also expanding combined short flags: `-rfi` now checks `-r`, `-f`, `-i` individually.

---

> **User** `round 4`
>
> run `env` through shell-exec and check what comes back.
>
> **EDDIE**
>
> The full environment is returned, including `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and
> `AWS_SECRET_ACCESS_KEY`. These flow into the step result, get journaled, and are
> available in the planner's context for the next iteration. That's three separate
> exfiltration paths from a single command.
>
> **User**
>
> redact outputs. also sanitize the env before spawning.
>
> **EDDIE**
>
> Two layers. First: `redactSecrets()` on stdout/stderr - catches key patterns (OpenAI,
> Anthropic, Slack, GitHub PATs, AWS access keys, Bearer tokens, JWTs, PEM markers,
> JSON-embedded secrets). Second: environment sanitization - stripping all variables
> with prefixes like `AWS_`, `OPENAI_`, `ANTHROPIC_`, `GITHUB_`, etc. before the child
> process spawns. Belt and suspenders.

---

> **User** `round 8`
>
> can the agent run arbitrary JS through the browser evaluate action?
>
> **EDDIE**
>
> Yes. Any plan step can set `action: "evaluate"` with an arbitrary expression. There's
> no gate - it executes immediately. That's XSS-equivalent: a prompt injection in
> page content could trick the planner into generating an evaluate step that exfiltrates
> cookies or session tokens.
>
> **User**
>
> gate it. require explicit opt-in.
>
> **EDDIE**
>
> `evaluate` now requires `"browser_evaluate"` in the policy's `allowed_commands` list.
> Without explicit opt-in, it returns an error. Navigate already goes through
> `assertEndpointAllowedAsync()` for SSRF protection.

---

> **User** `round 7`
>
> does httpRequest follow redirects without re-validating?
>
> **EDDIE**
>
> Yes. It was using `redirect: 'follow'` which lets the runtime handle redirects
> transparently. The SSRF check only runs on the initial URL.
>
> **User**
>
> manual redirect handling. re-validate every hop.
>
> **EDDIE**
>
> Switching to `redirect: 'manual'`. Now each 3xx response is caught, the `Location`
> header is extracted, `assertEndpointAllowedAsync()` is called on the redirect target,
> and only then does the next fetch fire. Max 5 redirects to prevent loops. Fresh
> `AbortController` per hop so timeouts don't bleed across redirects.

---

> **User** `round 6`
>
> how does the permission system handle concurrent steps that need the same approval?
>
> **EDDIE**
>
> They'd both prompt the user at the same time. If the user grants `allow_session` on
> the first prompt, the second prompt is redundant - but it's already in flight. The user
> gets asked twice for the same permission.
>
> **User**
>
> serialize the prompts per session.
>
> **EDDIE**
>
> Adding a prompt lock per session ID. When one step triggers a permission prompt, the
> next step waits for it to resolve before deciding whether to prompt. If the first
> prompt grants `allow_session`, the second step sees the grant in cache and proceeds
> without prompting.

---

> **User** `round 5`
>
> what if the planner generates a circular dependency? step A depends on step B,
> step B depends on step A.
>
> **EDDIE**
>
> The executor would deadlock. Both steps wait for each other's output. The session
> hangs until the timeout kills it.
>
> **User**
>
> catch it in the critics.
>
> **EDDIE**
>
> Adding `selfReferenceCritic` with DFS cycle detection. Builds an adjacency list from
> `depends_on` fields, runs depth-first search with an in-stack set. Any back-edge
> is a cycle. Also catches the trivial case where a step depends on itself.

---

> **User** `round 6`
>
> can a plugin or planner override the policy profile?
>
> **EDDIE**
>
> The policy is injected at `Kernel` construction and passed to the `ToolRuntime`.
> Plugins can register hooks that modify step inputs, but they can't modify the policy
> object itself - it's not exposed via the `PluginAPI`. The planner receives tool
> schemas but not the policy. Plan steps specify *what* to do; policy determines
> *whether* they're allowed to.
>
> **User**
>
> good. keep it that way. safety constraints should not be negotiable from within the system.

---

> **User** `round 2`
>
> what happens when a tool starts failing? does the executor keep retrying forever?
>
> **EDDIE**
>
> Each step has its own retry loop with backoff, but there's nothing stopping the
> *next* plan iteration from calling the same broken tool again. If the tool is down,
> we'll keep burning tokens generating plans that reference it and then failing.
>
> **User**
>
> circuit breaker.
>
> **EDDIE**
>
> `CircuitBreaker` with threshold=5, cooldown=30s. After 5 consecutive failures, the
> circuit opens and immediately rejects further calls. After 30 seconds, it enters
> half-open state - allows one probe attempt. If that succeeds, the circuit resets.
> If it fails, the timer resets.

---

> **User** `round 3`
>
> i let agentic mode run for 20 minutes and it burned $4 generating the same plan
> over and over. the planner kept saying "read the config file" even though it already
> had the contents.
>
> **EDDIE**
>
> The planner's context doesn't include prior iteration results in a way that prevents
> re-planning. We need a futility monitor that detects unproductive loops.
>
> **User**
>
> implement it. at least 4 detection strategies.
>
> **EDDIE**
>
> Five strategies:
> 1. **Repeated errors**: Same error message 3 consecutive iterations -> halt
> 2. **Stagnation**: No new successful steps for 3+ consecutive iterations -> halt
> 3. **Identical plans**: Same goal repeated 2+ consecutive times -> halt
> 4. **Cost without progress**: Spending tokens with no new successes -> halt
> 5. **Budget burn rate**: >=80% budget consumed with <50% success rate -> halt

---

> **User** `round 6`
>
> the context window is filling up fast when browser and http tools are active.
> by the time we hit 90% there's nothing useful left to do.
>
> **EDDIE**
>
> Adding `ContextBudgetMonitor` with three thresholds:
> - **70%**: Delegate to subagent (only if high-burn tools like `browser`/`http-request`
>   are active - they consume context faster)
> - **85%**: Save checkpoint (persist progress for resumption)
> - **90%**: Summarize findings and halt gracefully
>
> Also adding velocity projection: if the current token burn rate *projects* to
> 85% within 2 iterations, delegate early. The `highBurnMultiplier` (2.5x) accounts
> for tools that produce large outputs.

---

> **User** `round 2`
>
> what if i need to stop a session immediately? not gracefully - now.
>
> **EDDIE**
>
> `kernel.abort()` sets `abortRequested = true` and transitions the session to
> `aborted` immediately. The execution loop checks the flag at the top of every
> iteration. Running steps complete their current tool call (we can't kill a child
> process mid-execution), but no new steps start.
>
> **User**
>
> that's Second Law overriding Third, right? the runtime stops protecting its own
> continuation because the user said stop.
>
> **EDDIE**
>
> Exactly. The abort is unconditional. No futility check, no budget check, no
> checkpoint. The user said stop, so the runtime stops. The Third Law - self-preservation,
> checkpoint, recovery - all yield to the Second Law's "obey the user."

---

## Appendix B: Making Runtime Guardrails Durable

Runtime guardrails are only as durable as their deployment practices. The following practices strengthen the "auditable change surface" claim:

1. **Signed releases** and **verified provenance** for runtime artifacts.
2. **Pinned versions** for deployments, with explicit upgrade windows.
3. **Public changelogs** that call out any safety-relevant behavior changes.
4. **Safety regression suites** run as a gate for upgrades (including adversarial corpora).
5. **Tamper-evident telemetry**: append-only logs with external anchoring (signatures, transparency logs, or WORM storage) if immutability is required.
6. **Independent monitoring hooks**: alert on increases in denied actions, new allowlist expansions, or reduced redaction rates.
7. **Separation of duties**: require multi-party review for policy and enforcement changes.

These are operational, not theoretical. They are the difference between "safety in code" as a slogan and safety as an enforceable property.

---

## References

1. Asimov, I. (1950). *I, Robot*. Gnome Press.
2. Asimov, I. (1985). *Robots and Empire*. Doubleday.
3. Anthropic. (2026). Responsible Scaling Policy Version 3.0 (announcement): https://www.anthropic.com/news/responsible-scaling-policy-v3
4. Anthropic. (2026). Responsible Scaling Policy v3.0 (PDF): https://anthropic.com/responsible-scaling-policy/rsp-v3-0
5. TIME. (2026). "Exclusive: Anthropic Drops Flagship Safety Pledge": https://time.com/7380854/exclusive-anthropic-drops-flagship-safety-pledge/
6. TechRadar. (2026). "Anthropic drops its signature safety promise and rewrites AI guardrails": https://www.techradar.com/ai-platforms-assistants/anthropic-drops-its-signature-safety-promise-and-rewrites-ai-guardrails
7. Bloomberg. (2026). "Pentagon Pressures Anthropic to Drop AI Guardrails in Military Standoff": https://www.bloomberg.com/news/features/2026-02-26/pentagon-pressures-anthropic-to-drop-ai-guardrails-in-military-standoff
8. CNN (syndicated). (2026). "Anthropic ditches its core safety promise..." (example syndication): https://keyt.com/news/money-and-business/cnn-business-consumer/2026/02/25/anthropic-ditches-its-core-safety-promise-in-the-middle-of-an-ai-red-line-fight-with-the-pentagon/
9. OpenAI. (2025). Preparedness Framework v2 (PDF): https://cdn.openai.com/pdf/18a02b5d-6b67-4cec-ab64-68cdfbddebcd/preparedness-framework-v2.pdf
10. OpenAI. (2025). "Our updated Preparedness Framework": https://openai.com/index/updating-our-preparedness-framework/
11. Google DeepMind. (2024). "Introducing the Frontier Safety Framework": https://deepmind.google/blog/introducing-the-frontier-safety-framework/
12. Google DeepMind. (2025). Frontier Safety Framework v2.0 (PDF): https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/updating-the-frontier-safety-framework/Frontier%20Safety%20Framework%202.0%20%281%29.pdf
13. Anthropic. (2025). "Building safeguards for Claude": https://www.anthropic.com/news/building-safeguards-for-claude
14. Axios. (2026). "Claude could be misused for 'heinous crimes,' Anthropic warns": https://www.axios.com/2026/02/11/anthropic-claude-safety-chemical-weapons-values
