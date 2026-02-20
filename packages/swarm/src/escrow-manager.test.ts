import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EscrowManager, DEFAULT_BOND_REQUIREMENT } from "./escrow-manager.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JournalEventType } from "@karnevil9/schemas";

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
    expect(() => manager.deposit("node-1", 0)).toThrow("Deposit amount must be positive");
    expect(() => manager.deposit("node-1", -5)).toThrow("Deposit amount must be positive");
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

  // ─── getBondRequirement ─────────────────────────────────────────

  it("should return a copy of bond requirement", () => {
    const req = manager.getBondRequirement();
    expect(req).toEqual(DEFAULT_BOND_REQUIREMENT);

    // Mutating returned copy should not affect internal state
    req.min_bond_usd = 999;
    expect(manager.getBondRequirement().min_bond_usd).toBe(DEFAULT_BOND_REQUIREMENT.min_bond_usd);
  });
});
