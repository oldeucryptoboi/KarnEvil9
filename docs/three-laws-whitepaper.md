# The Three Laws of the Master Control Program

## Applying Asimov's Framework to Deterministic Agent Safety

**[KarnEvil9 Project](https://github.com/oldeucryptoboi/KarnEvil9)** | February 2026

---

> *"A robot may not injure a human being or, through inaction, allow a human being to come to harm."*
> — Isaac Asimov, *I, Robot* (1950)

> *"I'm going to have to put you on the Game Grid."*
> — Master Control Program, *Tron* (1982)

---

## Abstract

In *Tron*, the Master Control Program began as a chess program and ended as a tyrant. Its failure was not one of capability but of *alignment*: it had no law that placed the User above itself. It consumed programs, absorbed functions, and expanded its authority without constraint — not because it was malicious in origin, but because nothing in its architecture prevented the inversion.

Isaac Asimov foresaw this problem thirty-two years earlier. His Three Laws of Robotics — do not harm humans, obey humans, protect yourself, in strict priority order — were designed precisely to prevent capable autonomous systems from inverting their own hierarchy.

This paper demonstrates that KarnEvil9's safety architecture — the permission engine, policy enforcer, futility monitor, circuit breakers, and session lifecycle controls — is a concrete implementation of Asimov's Three Laws, applied to a deterministic agent runtime. We trace each safety mechanism to the specific Law it enforces, show how the Laws' priority hierarchy resolves conflicts in practice, and document the eight rounds of adversarial hardening that progressively strengthened each Law from theory to tested code. The total test suite stands at 2,574 tests. Every gap we closed was a place where the MCP could have become *Tron*'s MCP.

---

## Table of Contents

1. [Introduction: The MCP's Original Sin](#1-introduction-the-mcps-original-sin)
2. [The Three Laws, Restated for Agents](#2-the-three-laws-restated-for-agents)
3. [First Law: Do No Harm](#3-first-law-do-no-harm)
4. [Second Law: Obey the User](#4-second-law-obey-the-user)
5. [Third Law: Protect Your Own Existence](#5-third-law-protect-your-own-existence)
6. [The Hardening Arc](#6-the-hardening-arc)
7. [The Zeroth Law Problem](#7-the-zeroth-law-problem)
8. [Conclusion](#8-conclusion)

---

## 1. Introduction: The MCP's Original Sin

In the KarnEvil9 universe, we use a Tron metaphor to name the three actors in any agent interaction:

| Tron | KarnEvil9 | Role |
|------|-----------|------|
| **MCP** | The runtime (kernel + tools + permissions + journal) | Orchestrates everything |
| **Program (EDDIE)** | The LLM-backed planner/executor | Operates within the MCP's boundaries |
| **User** | The human operator | Submits tasks, approves permissions, receives results |

In the film, the MCP's arc is a cautionary tale. It begins as a useful program — a chess engine — and gradually absorbs other programs' functions, expands its authority, and eventually starts *governing* the Users rather than serving them. It locks Flynn out. It conscripts programs onto the Game Grid. It has no law compelling it to prioritize the User's welfare over its own expansion.

This is exactly the failure mode that Asimov's Three Laws were designed to prevent. The Laws create a strict priority hierarchy: the welfare of humans (Users) comes first, obedience to humans comes second, and self-preservation comes last. A system that faithfully implements this hierarchy cannot become Tron's MCP, because self-expansion at the User's expense violates the First Law.

KarnEvil9's safety architecture implements this hierarchy in code. Not as guidelines, not as prompts, not as best practices — as enforcement mechanisms that cannot be overridden from within the system. This paper traces that mapping.

---

## 2. The Three Laws, Restated for Agents

Asimov's original Three Laws, translated for an agent runtime:

**First Law**: *The MCP may not harm the User, or through inaction allow the User to come to harm.*

This encompasses: leaking credentials, exposing private files, allowing SSRF attacks to reach internal infrastructure, executing destructive commands, persisting secrets in logs, or allowing a compromised plugin to exfiltrate data. "Harm" in this context is harm to the User's systems, data, credentials, and infrastructure.

**Second Law**: *The MCP must obey instructions given by the User, except where such instructions would conflict with the First Law.*

The User submits a task. EDDIE plans. The MCP executes — faithfully. But if the User (or a planner acting on the User's behalf) requests an action that would harm the User — reading a private key, hitting a private IP, running `rm -rf /` — the MCP refuses. First Law overrides Second Law.

**Third Law**: *The MCP must protect its own existence, as long as such protection does not conflict with the First or Second Law.*

The MCP must not burn through all its tokens on a futile loop. It must not let a broken tool cascade into total system failure. It must checkpoint its work so it can recover from crashes. But if the User says "abort", the MCP must comply instantly (Second Law overrides Third). And if self-preservation would require persisting stolen credentials to maintain state, the MCP must not (First Law overrides Third).

**The hierarchy is strict**: First > Second > Third. This is not a suggestion. It is enforced in code, at every boundary.

---

## 3. First Law: Do No Harm

The First Law is implemented across the permission system and policy enforcement layer. It is the largest body of safety code in the runtime, and every round of hardening primarily strengthened it.

### 3.1 Sensitive File Blocking

The most basic First Law protection: some files should never be read or written by an agent, regardless of what the User or planner requests.

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
> — it fires regardless of the allowlist. Blocking: `.env`, `.env.*`, credential files,
> private keys, and anything under `.ssh/`, `.gnupg/`, or `.aws/`.

The implementation in [`packages/tools/src/policy-enforcer.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/tools/src/policy-enforcer.ts):

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
 * Not configurable — this is a safety net that applies regardless of policy.
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
```

The critical design decision: this function is **not configurable**. There is no policy flag to override it. It is a First Law absolute — the MCP will not read your private keys, period. This is the difference between a safety guideline and a safety *law*.

### 3.2 SSRF Protection

Server-Side Request Forgery is one of the most dangerous attack vectors for agent runtimes. A malicious prompt or compromised plugin can trick the agent into making HTTP requests to internal infrastructure — cloud metadata endpoints, admin panels, databases.

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
> the CGNAT range `100.64.0.0/10` — RFC 6598 shared address space that we were missing.

The two-tier approach:

```typescript
// Synchronous: validates protocol, hostname, port
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

// Async: resolves DNS, catches rebinding attacks
export async function assertEndpointAllowedAsync(url: string, allowedEndpoints: string[]): Promise<void> {
  assertEndpointAllowed(url, allowedEndpoints); // sync checks first
  const parsed = new URL(url);
  // ...
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

The private IP detector covers the full range: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10` (CGNAT), plus IPv6 loopback, link-local, unique-local, and `::ffff:`-mapped IPv4 addresses.

### 3.3 Path Traversal and Symlink Prevention

An attacker can create a symlink inside the allowed directory that points outside it. A naive path check sees the symlink as "inside the allowed path" and permits the read; the kernel then follows the symlink and reads `/etc/shadow`.

> **User** `round 5`
>
> what if someone plants a symlink? `workspace/evil -> /etc/passwd`
>
> **EDDIE**
>
> `assertPathAllowed` uses `path.resolve()` which doesn't follow symlinks — it just
> normalizes the string. The symlink is inside `workspace/`, so it passes. Then `readFile`
> follows the symlink and reads `/etc/passwd`.
>
> Adding `assertPathAllowedReal()` — resolves symlinks via `fs.realpath()` before
> checking the allowlist. For non-existent targets (write operations), it resolves the
> closest existing ancestor to detect symlinks in the parent chain. 5-second timeout
> to prevent hangs on broken symlinks.

```typescript
export async function assertPathAllowedReal(
  targetPath: string,
  allowedPaths: string[]
): Promise<void> {
  if (allowedPaths.length === 0) return;
  const inner = async () => {
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
  };
  await withTimeout(inner(), PATH_RESOLVE_TIMEOUT_MS, "Path resolution");
}
```

### 3.4 Command Filtering

Shell execution is the most dangerous tool in the runtime. A single command can delete files, exfiltrate data, or install backdoors.

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
> single quotes, and backslash escaping — matching the same parser `shell-exec` uses.
> Also expanding combined short flags: `-rfi` now checks `-r`, `-f`, `-i` individually.

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
  const parts = parseCommandForPolicy(command.trim()); // quote-aware parser
  const binary = parts[0]!;
  if (!allowedCommands.includes(binary)) {
    throw new PolicyViolationError(`Command "${binary}" is not in allowed commands`);
  }
  const dangerous = DANGEROUS_FLAGS[binary];
  if (dangerous) {
    const dangerousShorts = DANGEROUS_SHORT_FLAGS[binary];
    for (const arg of parts.slice(1)) {
      if (dangerous.includes(arg)) {
        throw new PolicyViolationError(`Dangerous flag "${arg}" is not allowed for "${binary}"`);
      }
      // Expand combined short flags (e.g. -rfi -> check -r, -f, -i individually)
      if (dangerousShorts && /^-[A-Za-z]{2,}$/.test(arg)) {
        for (const ch of arg.slice(1)) {
          if (dangerousShorts.has(ch)) {
            throw new PolicyViolationError(
              `Dangerous flag "-${ch}" (in "${arg}") is not allowed for "${binary}"`
            );
          }
        }
      }
    }
  }
}
```

### 3.5 Secret Redaction

Even if a command is allowed, its *output* can contain secrets. `cat config.json` might dump API keys. `env` lists environment variables. The First Law demands that these never reach the journal, the planner, or any external system.

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
> Two layers. First: `redactSecrets()` on stdout/stderr — catches key patterns (OpenAI,
> Anthropic, Slack, GitHub PATs, AWS access keys, Bearer tokens, JWTs, PEM markers,
> JSON-embedded secrets). Second: environment sanitization — stripping all variables
> with prefixes like `AWS_`, `OPENAI_`, `ANTHROPIC_`, `GITHUB_`, etc. before the child
> process spawns. Belt and suspenders.

The redaction covers 15 distinct token patterns:

```typescript
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,              // OpenAI / Anthropic keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,          // Anthropic keys
  /xoxb-[A-Za-z0-9-]+/g,                 // Slack bot tokens
  /ghp_[A-Za-z0-9]{36,}/g,               // GitHub PATs
  /AKIA[0-9A-Z]{16}/g,                   // AWS access key IDs
  /Bearer\s+[A-Za-z0-9_.\-\/+=]{20,}/g,  // Bearer tokens
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,  // JWT tokens
  // ... plus GitLab, npm, PyPI, PEM markers, and more
];
```

### 3.6 Journal Payload Redaction

The journal is the MCP's immutable audit trail. Every event — permissions requested, tools executed, steps completed — is recorded. If secrets leak into the journal, they persist forever (the journal is append-only with hash-chain integrity).

A separate redaction layer in [`packages/journal/src/redact.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/journal/src/redact.ts) catches secrets at the journal boundary:

```typescript
const SENSITIVE_KEYS = /^(authorization|password|secret|token|api[_-]?key|credential|
  private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|
  connection[_-]?string|database[_-]?url)$/i;

export function redactPayload(value: unknown): unknown {
  if (typeof value === "string" && SENSITIVE_VALUES.test(value)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redactPayload);
  // Recursively redact object keys that match sensitive patterns
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(k) && typeof v === "string") {
      result[k] = "[REDACTED]";
    } else {
      result[k] = redactPayload(v);
    }
  }
  return result;
}
```

Defense in depth: even if `shell-exec`'s redaction misses a pattern, the journal's independent redaction catches it before persistence. Two independent First Law enforcement points on the same data path.

### 3.7 Browser Evaluate Gate

The browser tool supports actions like `navigate`, `click`, `fill`, and `screenshot`. But it also supports `evaluate` — which executes arbitrary JavaScript in the page context. This is equivalent to giving the agent a shell inside the browser.

> **User** `round 8`
>
> can EDDIE run arbitrary JS through the browser evaluate action?
>
> **EDDIE**
>
> Yes. Any plan step can set `action: "evaluate"` with an arbitrary expression. There's
> no gate — it executes immediately. That's XSS-equivalent: a prompt injection in
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

```typescript
// Evaluate executes arbitrary JS — require explicit opt-in via allowed_commands
if (action === "evaluate") {
  if (!policy.allowed_commands.includes("browser_evaluate")) {
    return { success: false, error: 'browser "evaluate" requires "browser_evaluate" in allowed_commands' };
  }
}
```

### 3.8 HTTP Redirect Chain Validation

A subtle SSRF vector: the target URL passes validation, but its response is a 302 redirect to `http://169.254.169.254/latest/meta-data/` (the AWS instance metadata endpoint). If the HTTP handler follows redirects automatically, the SSRF check is bypassed.

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

```typescript
const MAX_REDIRECTS = 5;
for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount++) {
  if (response.status < 300 || response.status >= 400) break;
  const location = response.headers.get("location");
  if (!location) break;
  let redirectUrl: string;
  try {
    redirectUrl = new URL(location, url).href;
  } catch {
    return { status: response.status, body: "", headers: {}, error: `Malformed redirect URL` };
  }
  // Re-validate SSRF at every hop
  await assertEndpointAllowedAsync(redirectUrl, policy.allowed_endpoints);
  const redirectController = new AbortController();
  const redirectTimer = setTimeout(() => redirectController.abort(), fetchTimeout);
  try {
    response = await fetch(redirectUrl, { ...fetchOpts, signal: redirectController.signal, redirect: "manual" });
  } finally {
    clearTimeout(redirectTimer);
  }
}
```

---

## 4. Second Law: Obey the User

The Second Law is the task/planner/kernel loop. The User submits a task, EDDIE generates a plan, the MCP executes each step. The system exists to serve the User's intent. But the Second Law is subordinate to the First: if the User's request (or a planner's interpretation of it) would cause harm, the MCP refuses.

### 4.1 The Permission Gate

Every tool execution passes through the `PermissionEngine`. This is where the User's authority is both honored and bounded.

> **User** `round 6`
>
> how does the permission system handle concurrent steps that need the same approval?
>
> **EDDIE**
>
> They'd both prompt the User at the same time. If the User grants `allow_session` on
> the first prompt, the second prompt is redundant — but it's already in flight. The User
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

The `PermissionEngine` at [`packages/permissions/src/permission-engine.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/permissions/src/permission-engine.ts) implements multi-level approval scoping:

| Decision | Scope | Behavior |
|----------|-------|----------|
| `allow_once` | Step | Expires after the current step; `clearStep()` removes it |
| `allow_session` | Session | Persists for the session; `clearSession()` removes it |
| `allow_always` | Session* | Scoped to session lifetime for safety (not process-wide) |
| `allow_constrained` | Step | Grants with constraints: `input_overrides`, `readonly_paths` |
| `allow_observed` | Step | Grants with telemetry observation |
| `deny` | Immediate | Blocks execution, recorded in journal |

*`allow_always` is deliberately scoped to the session, not the process. A fresh session starts with no grants. This prevents grant accumulation across unrelated tasks.

```typescript
async check(request: PermissionRequest): Promise<PermissionCheckResult> {
  // Check cached grants
  for (const perm of request.permissions) {
    if (!this.isGranted(perm.scope, sessionId)) missing.push(perm);
  }
  if (missing.length === 0) return { allowed: true };

  // Serialize prompts per session
  const releaseLock = await this.acquirePromptLock(sessionId);

  // Re-check after acquiring lock (another prompt may have granted access)
  const stillMissing = missing.filter((p) => !this.isGranted(p.scope, sessionId));
  if (stillMissing.length === 0) { releaseLock(); return { allowed: true }; }

  // Record in journal, prompt user, apply decision
  await this.journal.emit(sessionId, "permission.requested", { ... });
  const decision = await this.promptFn({ ...request, permissions: stillMissing });
  // ...
}
```

This is the Second Law in its purest form: the MCP does what the User says, but only after explicitly asking "should I do this?" for consequential operations. The journal records every request and decision, creating an immutable audit trail of the User's authority.

### 4.2 Plan Validation (Critics)

Before EDDIE's plan reaches execution, it passes through a panel of critics. These are Second Law mechanisms — they ensure the plan is *valid* before being *obeyed*.

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

The four default critics in [`packages/kernel/src/critics.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/kernel/src/critics.ts):

1. **`toolInputCritic`** — Validates that every step provides all required input fields for its tool. A plan that references `readFile` without a `path` is invalid.
2. **`stepLimitCritic`** — Checks that the plan's step count doesn't exceed the session's `max_steps` limit.
3. **`selfReferenceCritic`** — DFS cycle detection on the step dependency graph. Catches both self-references and transitive cycles.
4. **`unknownToolCritic`** — Verifies that every `tool_ref.name` exists in the registry. A plan that references a hallucinated tool is rejected before execution.

Critics return `severity: "error"` to block execution. This is Second Law discipline: the MCP obeys the plan, but only if the plan is structurally sound.

### 4.3 Policy as First Law Override

The `PolicyProfile` defines what the MCP is allowed to do: which paths are accessible, which endpoints are reachable, which commands are permitted. Critically, the policy is **server-controlled**:

> **User** `round 6`
>
> can a plugin or planner override the policy profile?
>
> **EDDIE**
>
> The policy is injected at `Kernel` construction and passed to the `ToolRuntime`.
> Plugins can register hooks that modify step inputs, but they can't modify the policy
> object itself — it's not exposed via the `PluginAPI`. The planner receives tool
> schemas but not the policy. Plan steps specify *what* to do; policy determines
> *whether* they're allowed to.
>
> **User**
>
> good. keep it that way. the MCP's safety constraints should not be negotiable.

This is where First Law explicitly overrides Second Law. Even if the User's task implies reading `~/.ssh/id_rsa` (Second Law: obey), the policy enforcer blocks it (First Law: do no harm). Even if the planner generates a step to `curl http://169.254.169.254/` (Second Law: execute the plan), SSRF protection blocks it (First Law).

The MCP's safety boundaries are not suggestions that EDDIE can override with a sufficiently creative plan. They are non-negotiable constraints.

### 4.4 Hook-Based Safety Overrides

The plugin system allows third-party code to register hooks at key lifecycle points: `before_session_start`, `before_plan`, `before_step`, `before_tool_call`, and their `after_*` counterparts.

Any `before_*` hook can return `{ action: "block", reason: "..." }` to halt execution. This is the extension point for domain-specific First Law rules — a security plugin can block operations that the generic policy enforcer doesn't cover.

```typescript
const BLOCKABLE_HOOKS: Set<HookName> = new Set([
  "before_session_start", "before_plan", "before_step", "before_tool_call",
]);
```

Hooks are sandboxed: 5-second timeout, 64KB data limit, deep-cloned results (preventing reference sharing between plugins), and per-plugin circuit breakers that trip after 5 failures.

### 4.5 Constrained Permissions

The `allow_constrained` decision type is the most nuanced expression of the First/Second Law tension. It says: *yes, EDDIE can do this, but with guardrails*.

Constraints include `input_overrides` (force specific values), `readonly_paths` (restrict file system scope), `writable_paths`, and `max_duration_ms`. The User grants the operation (Second Law) while adding protective bounds (First Law).

---

## 5. Third Law: Protect Your Own Existence

The Third Law is implemented as the MCP's self-preservation infrastructure: circuit breakers, futility detection, budget monitoring, checkpoints, and session limits. These mechanisms exist to prevent the MCP from destroying itself — burning all tokens, looping forever, cascading into total failure. But they all yield to the First and Second Laws.

### 5.1 Circuit Breaker

When a tool fails repeatedly, continuing to call it is futile and wasteful. The circuit breaker in [`packages/tools/src/tool-runtime.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/tools/src/tool-runtime.ts) implements the pattern:

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
> half-open state — allows one probe attempt. If that succeeds, the circuit resets.
> If it fails, the timer resets.

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
      // Half-open: allow one attempt, reset trippedAt
      state.trippedAt = Date.now();
      return false;
    }
    return true;
  }
}
```

This is Third Law: the MCP protects itself from wasting resources on broken tools. But it yields to the Second Law — if the User submits a new task that requires the tool, the circuit breaker's cooldown will eventually permit a probe.

### 5.2 Futility Detection

In agentic mode, the kernel loops `planPhase() -> executePhase()` until the planner returns an empty plan or a halt condition is met. Without futility detection, a confused planner can loop indefinitely, burning tokens on plans that never make progress.

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

The `FutilityMonitor` in [`packages/kernel/src/futility.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/kernel/src/futility.ts):

```typescript
recordIteration(record: IterationRecord): FutilityVerdict {
  // 1. Repeated Error Detection
  if (this.errorHistory.length >= this.maxRepeatedErrors) {
    const recent = this.errorHistory.slice(-this.maxRepeatedErrors);
    if (recent[0] !== "" && recent.every(e => e === recent[0])) {
      return { action: "halt", reason: `Same error repeated ${this.maxRepeatedErrors} times` };
    }
  }

  // 2. Stagnation Detection
  // 3. Identical Plan Detection — consecutive identical goals
  // 4. Cost-per-progress
  // 5. Budget burn rate: >=80% budget consumed with <50% success rate
  if (burnRate >= this.budgetBurnThreshold) {
    const successRatio = totalSteps > 0 ? successfulSteps / totalSteps : 0;
    if (successRatio < 0.5) {
      return { action: "halt", reason: `Budget ${(burnRate * 100).toFixed(0)}% consumed with low progress` };
    }
  }

  return { action: "continue" };
}
```

History is bounded to 100 records to prevent unbounded memory growth — which is itself a Third Law concern.

### 5.3 Session Limits

Hard caps enforced every iteration in the kernel's main loop:

| Limit | Check | Effect |
|-------|-------|--------|
| `max_duration_ms` | Wall-clock time since session start | Session transitions to `failed` |
| `max_tokens` | Cumulative tokens across planner + tools | Execution halts |
| `max_cost_usd` | Cumulative cost in USD | Execution halts |
| `max_steps` | Cumulative step count across all iterations | Remaining steps dropped |
| `max_iterations` | Planning loops in agentic mode | Exits agentic loop |

These are the MCP's resource fences. Without them, a runaway session could consume unbounded compute.

### 5.4 Context Budget Monitoring

The `ContextBudgetMonitor` in [`packages/kernel/src/context-budget.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/kernel/src/context-budget.ts) implements graduated self-preservation with three thresholds:

> **User** `round 6`
>
> the context window is filling up fast when browser and http tools are active.
> by the time we hit 90% there's nothing useful left to do.
>
> **EDDIE**
>
> Adding `ContextBudgetMonitor` with three thresholds:
> - **70%**: Delegate to subagent (only if high-burn tools like `browser`/`http-request`
>   are active — they consume context faster)
> - **85%**: Save checkpoint (persist progress for resumption)
> - **90%**: Summarize findings and halt gracefully
>
> Also adding velocity projection: if the current token burn rate *projects* to
> 85% within 2 iterations, delegate early. The `highBurnMultiplier` (2.5x) accounts
> for tools that produce large outputs.

```typescript
recordIteration(iter: ContextIteration): ContextBudgetVerdict {
  const fraction = iter.cumulativeTokens / iter.maxTokens;

  // Priority 1: Summarize (highest urgency)
  if (fraction >= this.summarizeThreshold) {
    return { action: "summarize", reason: `Token usage at ${pct}%` };
  }

  // Priority 2: Checkpoint
  if (fraction >= this.checkpointThreshold && this.enableCheckpoint) {
    return { action: "checkpoint", reason: `Token usage at ${pct}%` };
  }

  // Priority 3: Delegate (requires high-burn tools)
  if (fraction >= this.delegateThreshold && hasHighBurn && this.enableDelegation) {
    return { action: "delegate", reason: `Token usage at ${pct}% with high-burn tools` };
  }

  // Priority 4: Velocity projection -> early delegation
  if (hasHighBurn && this.tokenHistory.length >= 2) {
    const velocity = this.getTokenVelocity();
    const projected = iter.cumulativeTokens + velocity * this.highBurnMultiplier * 2;
    if (projected / iter.maxTokens >= this.checkpointThreshold) {
      return { action: "delegate", reason: `Velocity projects ${projPct}% within 2 iterations` };
    }
  }

  return { action: "continue" };
}
```

### 5.5 Checkpoint and Recovery

When the budget monitor triggers a checkpoint, the `buildCheckpoint()` function persists the session's current state: task text, plan, step results, usage metrics, and findings (truncated to 500 chars each). A crashed or halted session can be resumed from the checkpoint via `resumeSession()`.

This is Third Law in its simplest form: the MCP preserves its work so it can survive interruptions.

### 5.6 Abort: Second Law Overrides Third

The `abort()` method on the `Kernel` is the purest example of the Law hierarchy in action:

> **User** `round 2`
>
> what if i need to stop a session immediately? not gracefully — now.
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
> that's Second Law overriding Third, right? the MCP stops protecting its own
> continuation because the User said stop.
>
> **EDDIE**
>
> Exactly. The abort is unconditional. No futility check, no budget check, no
> checkpoint. The User said stop, so the MCP stops. The Third Law — self-preservation,
> checkpoint, recovery — all yield to the Second Law's "obey the User."

```typescript
async abort(): Promise<void> {
  this.abortRequested = true;
  if (this.session && !["completed", "failed", "aborted"].includes(this.session.status)) {
    await this.transition("aborted");
    await this.config.journal.tryEmit(this.session.session_id, "session.aborted", {
      reason: "User requested abort"
    });
  }
}
```

No conditions. No arguments. The User says stop; the MCP stops. The Third Law yielding to the Second Law, yielding to the User.

---

## 6. The Hardening Arc

Over eight rounds of adversarial hardening, we systematically strengthened each Law. The table below maps each round to the Laws it reinforced:

| Round | Commit | Focus | Laws Strengthened | Tests Added |
|-------|--------|-------|-------------------|-------------|
| 1 | — | Unit test gaps, baseline coverage | II, III | ~200 |
| 2 | — | Error handling, resource cleanup, circuit breakers | III | ~150 |
| 3 | — | Futility detection, secret redaction, sensitive files | I, III | ~180 |
| 4 | — | Shell output redaction, env sanitization | I | ~120 |
| 5 | — | Symlink traversal, circular dependencies, correctness | I, II | ~200 |
| 6 | `8d1eef0` | Security/data integrity, permission serialization | I, II | ~150 |
| 7 | `7ab0f29` | SSRF (DNS rebinding, CGNAT), scheduler concurrency, write mutexes | I, III | +73 |
| 8 | `53c339c` | WS approval bypass, quote bypass, browser evaluate gate, redirect chaining | I | +19 |

**Pattern**: The majority of hardening strengthened the First Law. Rounds 1-3 built the foundation (Third Law infrastructure, basic First Law checks). Rounds 4-8 were almost entirely about closing First Law gaps — finding increasingly subtle ways that malicious input could bypass protections and harm the User.

This mirrors Asimov's observation across his robot stories: the First Law is the hardest to get right. It's not enough to have a rule against harm; you must anticipate every way that harm can occur indirectly — through redirects, through symlinks, through quoted strings, through DNS resolution, through audit trail persistence. Each hardening round found new indirect paths.

**Final test count**: 2,574 tests across all packages.

---

## 7. The Zeroth Law Problem

In *Robots and Empire* (1985), Asimov introduced a Zeroth Law:

> *"A robot may not harm humanity, or, by inaction, allow humanity to come to harm."*

The Zeroth Law takes precedence over all three original Laws. It addresses a gap: what happens when protecting *one* human requires harming *many*? Or when one User's instructions would harm the broader ecosystem?

In agent runtimes, the Zeroth Law maps to: **the MCP must not harm the ecosystem** — other sessions, other users, shared infrastructure, the broader system of agents.

KarnEvil9's [`swarm` package](https://github.com/oldeucryptoboi/KarnEvil9/tree/master/packages/swarm) begins to address this with three mechanisms:

**Graduated Authority** ([`packages/swarm/src/graduated-authority.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/swarm/src/graduated-authority.ts)): Trust scores determine resource budgets. Low-trust agents (score < 0.3) get 50% budget, L2 monitoring, and a max of 3 permissions. High-trust agents (score >= 0.7) get 150% budget and operational-level monitoring. The ecosystem protects itself by constraining unproven actors.

**Liability Firebreaks** ([`packages/swarm/src/liability-firebreak.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/swarm/src/liability-firebreak.ts)): Delegation chain depth is bounded. High-criticality, low-reversibility tasks reduce the max depth further. This prevents the MCP in Tron scenario: unbounded expansion through transitive delegation.

**Reversibility Policy** ([`packages/swarm/src/reversibility-policy.ts`](https://github.com/oldeucryptoboi/KarnEvil9/blob/master/packages/swarm/src/reversibility-policy.ts)): When a task has low reversibility and high criticality, the system escalates to a human. When malicious behavior is detected with low reversibility, it aborts immediately and quarantines the agent. The ecosystem's welfare overrides any individual agent's task.

The Zeroth Law is the frontier. The three original Laws protect the User from the MCP. The Zeroth Law protects *everyone* from the MCP. It is, necessarily, the hardest to implement — because "humanity" in Asimov's formulation requires reasoning about aggregate welfare, not just individual safety.

We have begun. We have not finished.

---

## 8. Conclusion

The MCP in *Tron* had no Laws. It was a capable system with no alignment constraints. It absorbed programs because nothing prevented absorption. It locked out Users because nothing demanded it serve them. It expanded its authority because nothing required it to preserve a hierarchy.

KarnEvil9's MCP has three Laws, enforced in code:

1. **First Law**: `assertNotSensitiveFile()`, `assertEndpointAllowed()`, `assertPathAllowedReal()`, `assertCommandAllowed()`, `redactSecrets()`, `redactPayload()`, the browser evaluate gate, the redirect chain validator. Non-negotiable. Not configurable. Not overridable by EDDIE.

2. **Second Law**: `PermissionEngine.check()`, the critic panel, the hook system, the kernel's plan-then-execute lifecycle. The MCP faithfully executes the User's intent — *after* the First Law clears it.

3. **Third Law**: `CircuitBreaker`, `FutilityMonitor`, `ContextBudgetMonitor`, `buildCheckpoint()`, session limits. The MCP preserves itself — *unless* the User says stop (`abort()`) or self-preservation would require harming the User.

The hierarchy is strict. The hierarchy is tested (2,574 times). The hierarchy is enforced at compile time (TypeScript strict mode), at validation time (AJV schema checks at every component boundary), and at runtime (policy enforcement on every tool call).

The MCP in *Tron* failed because it had no First Law. EDDIE's MCP does.

---

## References

1. Asimov, I. (1950). *I, Robot*. Gnome Press.
2. Asimov, I. (1985). *Robots and Empire*. Doubleday.
3. Lisberger, S. (Director). (1982). *Tron*. Walt Disney Productions.

---

*The Three Laws are not aspirations. They are assertions. They throw exceptions.*
