import { randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalEventType } from "@karnevil9/schemas";
import type { EscrowAccount, EscrowTransaction, BondRequirement } from "./types.js";

export const DEFAULT_BOND_REQUIREMENT: BondRequirement = {
  min_bond_usd: 0.1,
  slash_pct_on_violation: 50,
  slash_pct_on_timeout: 25,
};

const MAX_TRANSACTIONS_PER_ACCOUNT = 500;
const MAX_TASK_BONDS = 50_000;

export class EscrowManager {
  private accounts = new Map<string, EscrowAccount>();
  private taskBonds = new Map<string, { node_id: string; amount: number }>(); // task_id -> bond info
  private filePath: string;
  private bondRequirement: BondRequirement;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(
    filePath: string,
    bondRequirement?: Partial<BondRequirement>,
    emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void,
  ) {
    this.filePath = filePath;
    this.bondRequirement = { ...DEFAULT_BOND_REQUIREMENT, ...bondRequirement };
    this.emitEvent = emitEvent;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      this.accounts.clear();
      for (const line of lines) {
        try {
          const account = JSON.parse(line) as EscrowAccount;
          this.accounts.set(account.node_id, account);
        } catch {
          // Skip corrupted lines rather than losing all accounts
        }
      }
    } catch {
      this.accounts.clear();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.accounts.values()];
    const content = entries.map(a => JSON.stringify(a)).join("\n") + (entries.length > 0 ? "\n" : "");
    const tmpPath = this.filePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  deposit(nodeId: string, amount: number): EscrowAccount {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Deposit amount must be a finite positive number");

    let account = this.accounts.get(nodeId);
    if (!account) {
      account = { node_id: nodeId, balance: 0, held: 0, transactions: [] };
      this.accounts.set(nodeId, account);
    }

    account.balance += amount;
    const tx: EscrowTransaction = {
      transaction_id: randomUUID(),
      node_id: nodeId,
      type: "deposit",
      amount,
      timestamp: new Date().toISOString(),
    };
    account.transactions.push(tx);
    if (account.transactions.length > MAX_TRANSACTIONS_PER_ACCOUNT) {
      account.transactions = account.transactions.slice(-MAX_TRANSACTIONS_PER_ACCOUNT);
    }

    return account;
  }

  holdBond(taskId: string, nodeId: string, amount: number): { held: boolean; reason?: string } {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { held: false, reason: "Bond amount must be a finite positive number" };
    }
    const account = this.accounts.get(nodeId);
    if (!account) {
      return { held: false, reason: "No escrow account" };
    }

    const freeBalance = account.balance - account.held;
    if (freeBalance < amount) {
      return { held: false, reason: `Insufficient free balance: ${freeBalance} < ${amount}` };
    }

    account.held += amount;
    // Cap task bonds to prevent unbounded memory growth
    if (this.taskBonds.size >= MAX_TASK_BONDS && !this.taskBonds.has(taskId)) {
      return { held: false, reason: `Max concurrent bonds (${MAX_TASK_BONDS}) exceeded` };
    }
    this.taskBonds.set(taskId, { node_id: nodeId, amount });

    const tx: EscrowTransaction = {
      transaction_id: randomUUID(),
      node_id: nodeId,
      task_id: taskId,
      type: "hold",
      amount,
      timestamp: new Date().toISOString(),
    };
    account.transactions.push(tx);
    if (account.transactions.length > MAX_TRANSACTIONS_PER_ACCOUNT) {
      account.transactions = account.transactions.slice(-MAX_TRANSACTIONS_PER_ACCOUNT);
    }

    this.emitEvent?.("swarm.bond_held" as JournalEventType, {
      task_id: taskId,
      node_id: nodeId,
      amount,
    });

    return { held: true };
  }

  releaseBond(taskId: string): { released: boolean; amount?: number } {
    const bond = this.taskBonds.get(taskId);
    if (!bond) return { released: false };

    const account = this.accounts.get(bond.node_id);
    if (!account) return { released: false };

    account.held = Math.max(0, account.held - bond.amount);
    this.taskBonds.delete(taskId);

    const tx: EscrowTransaction = {
      transaction_id: randomUUID(),
      node_id: bond.node_id,
      task_id: taskId,
      type: "release",
      amount: bond.amount,
      timestamp: new Date().toISOString(),
    };
    account.transactions.push(tx);
    if (account.transactions.length > MAX_TRANSACTIONS_PER_ACCOUNT) {
      account.transactions = account.transactions.slice(-MAX_TRANSACTIONS_PER_ACCOUNT);
    }

    this.emitEvent?.("swarm.bond_released" as JournalEventType, {
      task_id: taskId,
      node_id: bond.node_id,
      amount: bond.amount,
    });

    return { released: true, amount: bond.amount };
  }

  slashBond(taskId: string, slashPct?: number): { slashed: boolean; amount?: number } {
    const bond = this.taskBonds.get(taskId);
    if (!bond) return { slashed: false };

    const account = this.accounts.get(bond.node_id);
    if (!account) return { slashed: false };

    const pct = Math.min(Math.max(0, slashPct ?? this.bondRequirement.slash_pct_on_violation), 100);
    const slashAmount = bond.amount * (pct / 100);

    account.held = Math.max(0, account.held - bond.amount);
    account.balance = Math.max(0, account.balance - slashAmount);
    this.taskBonds.delete(taskId);

    const tx: EscrowTransaction = {
      transaction_id: randomUUID(),
      node_id: bond.node_id,
      task_id: taskId,
      type: "slash",
      amount: slashAmount,
      timestamp: new Date().toISOString(),
    };
    account.transactions.push(tx);
    if (account.transactions.length > MAX_TRANSACTIONS_PER_ACCOUNT) {
      account.transactions = account.transactions.slice(-MAX_TRANSACTIONS_PER_ACCOUNT);
    }

    this.emitEvent?.("swarm.bond_slashed" as JournalEventType, {
      task_id: taskId,
      node_id: bond.node_id,
      slashed_amount: slashAmount,
      slash_pct: pct,
    });

    return { slashed: true, amount: slashAmount };
  }

  getAccount(nodeId: string): EscrowAccount | undefined {
    return this.accounts.get(nodeId);
  }

  getFreeBalance(nodeId: string): number {
    const account = this.accounts.get(nodeId);
    if (!account) return 0;
    return account.balance - account.held;
  }

  getBondRequirement(): BondRequirement {
    return { ...this.bondRequirement };
  }

  get accountCount(): number {
    return this.accounts.size;
  }
}
