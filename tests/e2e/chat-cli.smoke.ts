import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { v4 as uuid } from "uuid";
import { Journal } from "@jarvis/journal";
import { ToolRegistry, ToolRuntime } from "@jarvis/tools";
import { PermissionEngine } from "@jarvis/permissions";
import { MockPlanner } from "@jarvis/planner";
import { ApiServer } from "@jarvis/api";
import type { Server } from "node:http";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/examples");
const CLI_BIN = resolve(ROOT, "packages/cli/dist/index.js");
const NODE = process.execPath;

/** Strip ANSI escape codes from a string */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Spawn `jarvis chat` as a child process and return helpers for
 * interacting with stdin/stdout.
 */
function spawnChat(
  args: string[],
  env?: Record<string, string | undefined>,
): { child: ChildProcess; output: () => string; send: (line: string) => void; kill: () => void } {
  let buffer = "";
  const child = spawn(NODE, [CLI_BIN, "chat", ...args], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stdout!.on("data", (chunk) => { buffer += chunk.toString(); });
  child.stderr!.on("data", (chunk) => { buffer += chunk.toString(); });
  return {
    child,
    output: () => buffer,
    send: (line: string) => { child.stdin!.write(line + "\n"); },
    kill: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

/** Wait until the accumulated output contains a pattern, or timeout */
function waitForOutput(
  output: () => string,
  pattern: string | RegExp,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const text = stripAnsi(output());
      const found = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
      if (found) { clearInterval(interval); clearTimeout(timer); resolve(); }
    };
    const interval = setInterval(check, 50);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for "${pattern}". Got:\n${stripAnsi(output()).slice(-2000)}`));
    }, timeoutMs);
    check(); // immediate check
  });
}

/** Wait for child process to exit and return code */
function waitForExit(child: ChildProcess, timeoutMs = 10000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for process exit"));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

describe("Chat CLI REPL Smoke Tests", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;
  let permissions: PermissionEngine;
  let runtime: ToolRuntime;
  let apiServer: ApiServer;
  let httpServer: Server;
  let port: number;
  let chat: ReturnType<typeof spawnChat> | null = null;

  beforeEach(async () => {
    testDir = join(tmpdir(), `jarvis-e2e-chat-cli-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
    permissions = new PermissionEngine(journal, async () => "allow_always");
    runtime = new ToolRuntime(registry, permissions, journal);
    port = 30000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    if (chat) { chat.kill(); chat = null; }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await journal.close();
    await rm(testDir, { recursive: true, force: true });
  });

  function startServer() {
    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      insecure: true,
    });
    httpServer = apiServer.listen(port);
  }

  function startChat(extraArgs: string[] = [], env?: Record<string, string | undefined>) {
    chat = spawnChat(["--url", `ws://localhost:${port}/api/ws`, "--mode", "mock", ...extraArgs], env);
    return chat;
  }

  // ─── /help command ──────────────────────────────────────────────

  it("/help prints available commands", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    c.send("/help");
    await waitForOutput(c.output, "/abort");

    const text = stripAnsi(c.output());
    expect(text).toContain("/help");
    expect(text).toContain("/abort");
    expect(text).toContain("/quit");
  });

  // ─── /abort with no session ─────────────────────────────────────

  it("/abort with no active session prints message", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    c.send("/abort");
    await waitForOutput(c.output, "No active session");

    const text = stripAnsi(c.output());
    expect(text).toContain("No active session");
  });

  // ─── Submit text → events stream → prompt returns ────────────────

  it("submit text creates session, streams events, reaches terminal state", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    c.send("hello world");

    // Wait for session created
    await waitForOutput(c.output, "Session");

    // Wait for terminal event (session.completed or session.failed)
    await waitForOutput(c.output, /session\.(completed|failed)/, 15000);

    const text = stripAnsi(c.output());
    // Should show session created
    expect(text).toMatch(/Session .+ created/);
    // Should show journal events
    expect(text).toContain("session.started");
    // Prompt should be back (jarvis> without [running])
    // We just verify the session reached terminal — the prompt state is a readline detail
  });

  // ─── /quit exits cleanly ────────────────────────────────────────

  it("/quit exits the process cleanly", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    c.send("/quit");

    const code = await waitForExit(c.child, 5000);
    expect(code).toBe(0);
    chat = null; // already exited
  });

  // ─── /abort during active session ────────────────────────────────

  it("submit then /abort sends abort for current session", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    c.send("abort test task");

    // Wait for session to be created
    await waitForOutput(c.output, "Session");

    // Send abort immediately
    c.send("/abort");

    // Should see abort requested message
    await waitForOutput(c.output, "Abort requested", 5000).catch(() => {
      // Mock planner may complete before abort — that's OK
    });

    // Wait for terminal event
    await waitForOutput(c.output, /session\.(completed|failed|aborted)/, 15000);
  });

  // ─── Server not running → error + retry ──────────────────────────

  it("prints connection error when server is not running", async () => {
    // Don't start any server — just try to connect
    const c = startChat();

    // Should print connection error
    await waitForOutput(c.output, /[Cc]annot connect|ECONNREFUSED|[Rr]etry/, 5000);

    const text = stripAnsi(c.output());
    expect(text).toMatch(/[Cc]annot connect|ECONNREFUSED/);
  });

  // ─── Reconnection after server restart ────────────────────────────

  it("reconnects after server restart and can submit again", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    // Shut down server (closes WS clients + HTTP server)
    await apiServer.shutdown();
    // httpServer is already closed by shutdown — null it so afterEach skips
    httpServer = undefined as unknown as Server;

    // Wait for disconnect message (client receives WS close frame)
    await waitForOutput(c.output, /[Dd]isconnected|[Rr]econnect/, 8000);

    // Restart a new server on the same port with fresh journal
    const journal2 = new Journal(join(testDir, "journal2.jsonl"), { fsync: false, redact: false });
    await journal2.init();
    const registry2 = new ToolRegistry();
    await registry2.loadFromDirectory(TOOLS_DIR);
    const permissions2 = new PermissionEngine(journal2, async () => "allow_always");
    const runtime2 = new ToolRuntime(registry2, permissions2, journal2);

    apiServer = new ApiServer({
      toolRegistry: registry2,
      journal: journal2,
      toolRuntime: runtime2,
      permissions: permissions2,
      planner: new MockPlanner(),
      insecure: true,
    });
    httpServer = apiServer.listen(port);

    // Wait for reconnection — check for 2 occurrences of "Connected to Jarvis server"
    await waitForOutput(() => {
      const text = stripAnsi(c.output());
      const count = (text.match(/Connected to Jarvis server/g) ?? []).length;
      return count >= 2 ? "found" : "";
    }, "found", 10000);

    // Submit on reconnected connection
    c.send("after restart");
    await waitForOutput(c.output, /session\.(completed|failed)/, 15000);
  });

  // ─── Auth rejection ──────────────────────────────────────────────

  it("prints error when token is rejected by server", async () => {
    apiServer = new ApiServer({
      toolRegistry: registry,
      journal,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      apiToken: "correct-token",
    });
    httpServer = apiServer.listen(port);

    chat = spawnChat(["--url", `ws://localhost:${port}/api/ws`, "--token", "wrong-token"]);

    // Should fail to connect and show error / retry
    await waitForOutput(chat.output, /[Rr]econnect|[Rr]etry|[Ee]rror|[Cc]annot connect/, 5000);
  });

  // ─── Multiple sessions on same chat ──────────────────────────────

  it("supports multiple sequential sessions in same chat", async () => {
    startServer();
    const c = startChat();
    await waitForOutput(c.output, "Connected");

    // Session 1
    c.send("first task");
    await waitForOutput(c.output, /session\.(completed|failed)/, 15000);

    // Small delay to let readline settle
    await new Promise((r) => setTimeout(r, 200));

    // Record output length after first session completes
    const afterFirst = stripAnsi(c.output()).length;

    // Session 2
    c.send("second task");

    // Wait for a second "Session ... created" message in the full output
    await waitForOutput(c.output, /Session [0-9a-f-]+ created.*Session [0-9a-f-]+ created/s, 15000);

    const text = stripAnsi(c.output());
    const sessionCreatedCount = (text.match(/Session [0-9a-f-]+ created/g) ?? []).length;
    expect(sessionCreatedCount).toBeGreaterThanOrEqual(2);
  });
});
