import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EscrowManager, DEFAULT_BOND_REQUIREMENT } from "./escrow-manager.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("EscrowManager", () => {
  let tmpDir: string;
  let manager: EscrowManager;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "escrow-test-"));
    emitEvent = vi.fn();
    manager = new EscrowManager(join(tmpDir, "escrow.jsonl"), undefined, emitEvent);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Deposit ────────────────────────────────────────────────────

  it("should create account and add balance on deposit", () => {
    const account = manager.deposit("node-1", 10);
    expect(account.node_id).toBe("node-1");
    expect(account.balance).toBe(10);
    expect(account.held).toBe(0);
    expect(account.transactions).toHaveLength(1);
    expect(account.transactions[0]!.type).toBe("deposit");
    expect(account.transactions[0]!.amount).toBe(10);
  });

  it("should add to existing account balance on subsequent deposit", () => {
    manager.deposit("node-1", 10);
    const account = manager.deposit("node-1", 5);
    expect(account.balance).toBe(15);
    expect(account.transactions).toHaveLength(2);
  });

  it("should throw on deposit with amount <= 0", () => {
    expect(() => manager.deposit("node-1", 0)).toThrow();
    expect(() => manager.deposit("node-1", -5)).toThrow();
  });

  it("should throw on deposit with NaN", () => {
    expect(() => manager.deposit("node-1", NaN)).toThrow("finite positive");
  });

  it("should throw on deposit with Infinity", () => {
    expect(() => manager.deposit("node-1", Infinity)).toThrow("finite positive");
    expect(() => manager.deposit("node-1", -Infinity)).toThrow("finite positive");
  });

  // ─── Hold Bond ──────────────────────────────────────────────────

  it("should hold bond when sufficient balance available", () => {
    manager.deposit("node-1", 10);
    const result = manager.holdBond("task-1", "node-1", 5);
    expect(result.held).toBe(true);
    expect(result.reason).toBeUndefined();

    const account = manager.getAccount("node-1");
    expect(account!.held).toBe(5);
    expect(account!.balance).toBe(10);
  });

  it("should reject hold when insufficient free balance", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 8);
    const result = manager.holdBond("task-2", "node-1", 5);
    expect(result.held).toBe(false);
    expect(result.reason).toContain("Insufficient free balance");
  });

  it("should reject hold when no account exists", () => {
    const result = manager.holdBond("task-1", "unknown-node", 5);
    expect(result.held).toBe(false);
    expect(result.reason).toBe("No escrow account");
  });

  it("should reject holdBond with NaN amount", () => {
    manager.deposit("node-1", 10);
    const result = manager.holdBond("task-nan", "node-1", NaN);
    expect(result.held).toBe(false);
    expect(result.reason).toContain("finite positive");
  });

  it("should reject holdBond with Infinity amount", () => {
    manager.deposit("node-1", 10);
    const result = manager.holdBond("task-inf", "node-1", Infinity);
    expect(result.held).toBe(false);
    expect(result.reason).toContain("finite positive");
  });

  // ─── Release Bond ───────────────────────────────────────────────

  it("should release bond and decrement held amount", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 5);

    const result = manager.releaseBond("task-1");
    expect(result.released).toBe(true);
    expect(result.amount).toBe(5);

    const account = manager.getAccount("node-1");
    expect(account!.held).toBe(0);
    expect(account!.balance).toBe(10); // balance unchanged after release
  });

  it("should return released: false for unknown task", () => {
    const result = manager.releaseBond("unknown-task");
    expect(result.released).toBe(false);
    expect(result.amount).toBeUndefined();
  });

  // ─── Slash Bond ─────────────────────────────────────────────────

  it("should slash bond with default percentage (50%)", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 6);

    const result = manager.slashBond("task-1");
    expect(result.slashed).toBe(true);
    expect(result.amount).toBe(3); // 50% of 6

    const account = manager.getAccount("node-1");
    expect(account!.held).toBe(0);
    expect(account!.balance).toBe(7); // 10 - 3
  });

  it("should slash bond with custom percentage", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 4);

    const result = manager.slashBond("task-1", 25);
    expect(result.slashed).toBe(true);
    expect(result.amount).toBe(1); // 25% of 4

    const account = manager.getAccount("node-1");
    expect(account!.balance).toBe(9); // 10 - 1
    expect(account!.held).toBe(0);
  });

  it("should reduce balance by slash amount and clear held", () => {
    manager.deposit("node-1", 20);
    manager.holdBond("task-1", "node-1", 10);

    manager.slashBond("task-1", 100); // slash 100% of bond
    const account = manager.getAccount("node-1");
    expect(account!.balance).toBe(10); // 20 - 10
    expect(account!.held).toBe(0);
  });

  it("should return slashed: false for unknown task", () => {
    const result = manager.slashBond("unknown-task");
    expect(result.slashed).toBe(false);
    expect(result.amount).toBeUndefined();
  });

  it("should clamp negative slashPct to 0", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-neg", "node-1", 6);

    const result = manager.slashBond("task-neg", -50);
    expect(result.slashed).toBe(true);
    expect(result.amount).toBe(0); // -50 clamped to 0
    const account = manager.getAccount("node-1");
    expect(account!.balance).toBe(10); // no balance reduction
    expect(account!.held).toBe(0);
  });

  it("should clamp slashPct above 100 to 100", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-over", "node-1", 4);

    const result = manager.slashBond("task-over", 200);
    expect(result.slashed).toBe(true);
    expect(result.amount).toBe(4); // 100% of 4
    const account = manager.getAccount("node-1");
    expect(account!.balance).toBe(6); // 10 - 4
  });

  it("should never allow negative balance after slash", () => {
    manager.deposit("node-1", 3);
    manager.holdBond("task-big-slash", "node-1", 3);

    // Slash 100% of a 3 bond when balance is also 3
    const result = manager.slashBond("task-big-slash", 100);
    expect(result.slashed).toBe(true);
    const account = manager.getAccount("node-1");
    expect(account!.balance).toBeGreaterThanOrEqual(0);
    expect(account!.held).toBeGreaterThanOrEqual(0);
  });

  it("should never allow negative held after release", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-rel", "node-1", 5);
    // Manually corrupt held to be less than bond
    const account = manager.getAccount("node-1")!;
    account.held = 2; // corrupted: less than the 5 bond

    const result = manager.releaseBond("task-rel");
    expect(result.released).toBe(true);
    // held should be clamped to 0, not go to -3
    expect(manager.getAccount("node-1")!.held).toBe(0);
  });

  // ─── Full Lifecycle ─────────────────────────────────────────────

  it("should preserve balance through deposit -> hold -> release", () => {
    manager.deposit("node-1", 100);
    manager.holdBond("task-1", "node-1", 30);

    expect(manager.getFreeBalance("node-1")).toBe(70);

    manager.releaseBond("task-1");
    expect(manager.getFreeBalance("node-1")).toBe(100);

    const account = manager.getAccount("node-1");
    expect(account!.balance).toBe(100);
    expect(account!.held).toBe(0);
  });

  it("should reduce balance through deposit -> hold -> slash", () => {
    manager.deposit("node-1", 100);
    manager.holdBond("task-1", "node-1", 20);

    manager.slashBond("task-1"); // default 50%
    const account = manager.getAccount("node-1");
    expect(account!.balance).toBe(90); // 100 - 10
    expect(account!.held).toBe(0);
  });

  // ─── Multiple Holds ─────────────────────────────────────────────

  it("should support multiple holds on same account", () => {
    manager.deposit("node-1", 100);
    manager.holdBond("task-1", "node-1", 20);
    manager.holdBond("task-2", "node-1", 30);

    expect(manager.getFreeBalance("node-1")).toBe(50);

    const account = manager.getAccount("node-1");
    expect(account!.held).toBe(50);

    manager.releaseBond("task-1");
    expect(manager.getFreeBalance("node-1")).toBe(70);
    expect(manager.getAccount("node-1")!.held).toBe(30);
  });

  // ─── getFreeBalance ─────────────────────────────────────────────

  it("should compute getFreeBalance as balance minus held", () => {
    manager.deposit("node-1", 50);
    manager.holdBond("task-1", "node-1", 15);
    expect(manager.getFreeBalance("node-1")).toBe(35);
  });

  it("should return 0 for getFreeBalance with no account", () => {
    expect(manager.getFreeBalance("unknown")).toBe(0);
  });

  // ─── getAccount ─────────────────────────────────────────────────

  it("should return undefined for unknown account", () => {
    expect(manager.getAccount("unknown")).toBeUndefined();
  });

  // ─── Events ─────────────────────────────────────────────────────

  it("should emit bond_held event on hold", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 5);

    expect(emitEvent).toHaveBeenCalledWith("swarm.bond_held", {
      task_id: "task-1",
      node_id: "node-1",
      amount: 5,
    });
  });

  it("should emit bond_released event on release", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 5);
    emitEvent.mockClear();

    manager.releaseBond("task-1");
    expect(emitEvent).toHaveBeenCalledWith("swarm.bond_released", {
      task_id: "task-1",
      node_id: "node-1",
      amount: 5,
    });
  });

  it("should emit bond_slashed event on slash", () => {
    manager.deposit("node-1", 10);
    manager.holdBond("task-1", "node-1", 8);
    emitEvent.mockClear();

    manager.slashBond("task-1", 25);
    expect(emitEvent).toHaveBeenCalledWith("swarm.bond_slashed", {
      task_id: "task-1",
      node_id: "node-1",
      slashed_amount: 2, // 25% of 8
      slash_pct: 25,
    });
  });

  // ─── Transaction History ────────────────────────────────────────

  it("should track transaction history correctly", () => {
    manager.deposit("node-1", 100);
    manager.holdBond("task-1", "node-1", 30);
    manager.releaseBond("task-1");

    const account = manager.getAccount("node-1");
    expect(account!.transactions).toHaveLength(3);
    expect(account!.transactions[0]!.type).toBe("deposit");
    expect(account!.transactions[1]!.type).toBe("hold");
    expect(account!.transactions[2]!.type).toBe("release");

    // Each transaction should have a unique ID
    const ids = account!.transactions.map(tx => tx.transaction_id);
    expect(new Set(ids).size).toBe(3);
  });

  // ─── Persistence ────────────────────────────────────────────────

  it("should round-trip through save and load", async () => {
    manager.deposit("node-1", 100);
    manager.deposit("node-2", 50);
    manager.holdBond("task-1", "node-1", 20);
    await manager.save();

    const manager2 = new EscrowManager(join(tmpDir, "escrow.jsonl"));
    await manager2.load();

    expect(manager2.accountCount).toBe(2);
    expect(manager2.getAccount("node-1")!.balance).toBe(100);
    expect(manager2.getAccount("node-2")!.balance).toBe(50);
    expect(manager2.getAccount("node-1")!.transactions).toHaveLength(2); // deposit + hold
  });

  // ─── accountCount ───────────────────────────────────────────────

  it("should track account count correctly", () => {
    expect(manager.accountCount).toBe(0);
    manager.deposit("node-1", 10);
    expect(manager.accountCount).toBe(1);
    manager.deposit("node-2", 20);
    expect(manager.accountCount).toBe(2);
    // Same node again should not increase count
    manager.deposit("node-1", 5);
    expect(manager.accountCount).toBe(2);
  });

  // ─── Task Bonds Cap ───────────────────────────────────────────

  it("should reject holdBond when taskBonds cap (50,000) is exceeded", () => {
    // We need to hold bonds for many unique tasks on accounts with sufficient balance
    // Deposit a huge amount to one account to make the balance check pass
    manager.deposit("node-big", 1_000_000);

    // Hold bonds up to the cap
    for (let i = 0; i < 50_000; i++) {
      const result = manager.holdBond(`task-cap-${i}`, "node-big", 0.01);
      expect(result.held).toBe(true);
    }

    // The next new task bond should be rejected
    // Note: held will have increased the account held amount, but balance is huge
    const result = manager.holdBond("task-overflow", "node-big", 0.01);
    expect(result.held).toBe(false);
    expect(result.reason).toContain("Max concurrent bonds");
  });

  it("should NOT mutate account.held when holdBond is rejected by cap (H18)", () => {
    // Verifies the fix: cap check runs BEFORE account.held mutation
    manager.deposit("node-big", 1_000_000);

    // Fill to cap
    for (let i = 0; i < 50_000; i++) {
      manager.holdBond(`task-cap2-${i}`, "node-big", 0.01);
    }

    const heldBefore = manager.getAccount("node-big")!.held;

    // This should be rejected without modifying account.held
    const result = manager.holdBond("task-overflow-2", "node-big", 0.01);
    expect(result.held).toBe(false);

    const heldAfter = manager.getAccount("node-big")!.held;
    expect(heldAfter).toBe(heldBefore);
  });

  // ─── getBondRequirement ─────────────────────────────────────────

  it("should return a copy of bond requirement", () => {
    const req = manager.getBondRequirement();
    expect(req).toEqual(DEFAULT_BOND_REQUIREMENT);

    // Mutating returned copy should not affect internal state
    req.min_bond_usd = 999;
    expect(manager.getBondRequirement().min_bond_usd).toBe(DEFAULT_BOND_REQUIREMENT.min_bond_usd);
  });
});
