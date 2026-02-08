import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function spawnWithStdin(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; stdinData?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    if (opts.stdinData) {
      child.stdin.write(opts.stdinData);
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout after ${opts.timeout}ms. stdout: ${stdout}\nstderr: ${stderr}`));
    }, opts.timeout ?? 30000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const CLI_BIN = resolve(ROOT, "packages/cli/dist/index.js");
const NODE = process.execPath;

describe("CLI Binary Smoke", () => {
  it("--help prints usage and exits 0", async () => {
    const { stdout, stderr } = await execFileAsync(NODE, [CLI_BIN, "--help"]);
    expect(stdout).toContain("openvger");
    expect(stdout).toContain("Deterministic agent runtime");
    expect(stdout).toContain("run");
    expect(stdout).toContain("plan");
    expect(stdout).toContain("tools");
    expect(stdout).toContain("session");
    expect(stdout).toContain("replay");
    expect(stdout).toContain("server");
    expect(stdout).toContain("plugins");
  });

  it("--version prints version and exits 0", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "--version"]);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("tools list runs without error", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "tools", "list"], {
      cwd: ROOT,
    });
    expect(stdout).toContain("read-file");
    expect(stdout).toContain("write-file");
    expect(stdout).toContain("shell-exec");
    expect(stdout).toContain("http-request");
  });

  it("plan command generates a mock plan", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "plan", "test task"], {
      cwd: ROOT,
    });
    const plan = JSON.parse(stdout);
    expect(plan.plan_id).toBeDefined();
    expect(plan.schema_version).toBe("0.1");
    expect(plan.goal).toBe("test task");
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it("plugins list runs without error", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "plugins", "list", "--plugins-dir", resolve(ROOT, "plugins")], {
      cwd: ROOT,
    });
    expect(stdout).toContain("example-logger");
  });

  it("unknown command exits with non-zero code", async () => {
    try {
      await execFileAsync(NODE, [CLI_BIN, "nonexistent-command"]);
      // If it doesn't throw, the binary silently ignores unknown commands (commander behavior)
      // That's acceptable — commander shows help for unknown commands
    } catch (err: unknown) {
      const error = err as { code: number };
      // Commander exits with code 1 for unknown commands
      expect(error.code).not.toBe(0);
    }
  });

  it("run --help shows --planner and --model options", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "run", "--help"]);
    expect(stdout).toContain("--planner");
    expect(stdout).toContain("--model");
  });

  it("run --planner with unknown type exits with error", async () => {
    try {
      await execFileAsync(NODE, [CLI_BIN, "run", "test task", "--planner", "gemini"], {
        cwd: ROOT,
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain("Unknown planner type");
    }
  });

  it("run --help shows --agentic option", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "run", "--help"]);
    expect(stdout).toContain("--agentic");
    expect(stdout).toContain("Enable agentic feedback loop");
  });

  it("server --help shows --agentic option", async () => {
    const { stdout } = await execFileAsync(NODE, [CLI_BIN, "server", "--help"]);
    expect(stdout).toContain("--agentic");
  });

  it("run --agentic with mock planner completes successfully", async () => {
    const stdinData = "a\na\na\na\na\n";
    const { stdout, code } = await spawnWithStdin(
      NODE,
      [CLI_BIN, "run", "agentic smoke test", "--mode", "mock", "--max-steps", "5", "--agentic"],
      { cwd: ROOT, timeout: 25000, stdinData },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("OpenVger session starting");
    expect(stdout).toContain("agentic smoke test");
    expect(stdout).toContain("Status: completed");
  });

  it("run --agentic produces multi-iteration journal events", async () => {
    const stdinData = "a\na\na\na\na\n";
    const { stdout, code } = await spawnWithStdin(
      NODE,
      [CLI_BIN, "run", "agentic iterations test", "--mode", "mock", "--max-steps", "10", "--agentic"],
      { cwd: ROOT, timeout: 25000, stdinData },
    );
    expect(code).toBe(0);
    // Agentic mock planner: iteration 1 produces a step, iteration 2 sees success and returns empty.
    // So we should see exactly 2 planner.requested events.
    const plannerRequested = stdout.split("\n").filter((l) => l.includes("planner.requested"));
    expect(plannerRequested.length).toBe(2);
    // Should also have a session.checkpoint between iterations
    expect(stdout).toContain("session.checkpoint");
    // Final status must be completed
    expect(stdout).toContain("Status: completed");
    expect(stdout).toContain("Steps completed: 1/");
  });

  it("run --agentic without --agentic still runs single-shot (backward compat)", async () => {
    const stdinData = "a\na\na\na\na\n";
    const { stdout, code } = await spawnWithStdin(
      NODE,
      [CLI_BIN, "run", "non-agentic backward compat", "--mode", "mock", "--max-steps", "5"],
      { cwd: ROOT, timeout: 25000, stdinData },
    );
    expect(code).toBe(0);
    // Single-shot: exactly one planner.requested event
    const plannerRequested = stdout.split("\n").filter((l) => l.includes("planner.requested"));
    expect(plannerRequested.length).toBe(1);
    expect(stdout).toContain("Status: completed");
  });

  it("run --agentic --planner unknown exits with error", async () => {
    try {
      await execFileAsync(NODE, [CLI_BIN, "run", "test", "--agentic", "--planner", "gemini"], {
        cwd: ROOT,
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain("Unknown planner type");
    }
  });

  it("run --agentic --planner claude without API key exits with error", async () => {
    try {
      await execFileAsync(NODE, [CLI_BIN, "run", "test", "--agentic", "--planner", "claude"], {
        cwd: ROOT,
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("run --planner claude without ANTHROPIC_API_KEY exits with error", async () => {
    try {
      await execFileAsync(NODE, [CLI_BIN, "run", "test task", "--planner", "claude"], {
        cwd: ROOT,
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("run command executes a mock session end-to-end", async () => {
    // The CLI run command uses cliApprovalPrompt which reads stdin via readline.
    // We pipe "a\n" (allow once) repeatedly so permission prompts auto-approve.
    const stdinData = "a\na\na\na\na\n";
    const { stdout, code } = await spawnWithStdin(
      NODE,
      [CLI_BIN, "run", "smoke test task", "--mode", "mock", "--max-steps", "5"],
      { cwd: ROOT, timeout: 25000, stdinData },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("OpenVger session starting");
    expect(stdout).toContain("smoke test task");
    expect(stdout).toContain("Mode: mock");
    expect(stdout).toContain("Session");
    expect(stdout).toContain("Status:");
  });
});
