import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramClient } from "./telegram-client.js";

// ── Mock grammY ──

function mockBotApi() {
  return {
    setMyCommands: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  };
}

function mockBot(api) {
  return {
    api,
    on: vi.fn(),
    catch: vi.fn(),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock the grammy import
vi.mock("grammy", () => {
  const api = mockBotApi();
  const bot = mockBot(api);
  return {
    Bot: vi.fn(() => bot),
    _bot: bot,
    _api: api,
  };
});

describe("TelegramClient", () => {
  let client;
  let grammyMock;

  beforeEach(async () => {
    // Get the mocked module
    grammyMock = await import("grammy");
    // Reset mocks
    grammyMock._api.setMyCommands.mockClear();
    grammyMock._api.sendMessage.mockClear().mockResolvedValue({ message_id: 42 });
    grammyMock._api.editMessageText.mockClear();
    grammyMock._api.sendChatAction.mockClear();
    grammyMock._bot.start.mockClear();
    grammyMock._bot.stop.mockClear();
    grammyMock._bot.on.mockClear();
    grammyMock._bot.catch.mockClear();

    client = new TelegramClient({ token: "test-token", logger: { warn: vi.fn(), error: vi.fn() } });
  });

  // ── start() ──

  describe("start", () => {
    it("sets bot commands on startup", async () => {
      await client.start();
      expect(grammyMock._api.setMyCommands).toHaveBeenCalledWith([
        { command: "status", description: "Show active sessions" },
        { command: "cancel", description: "Cancel current session" },
        { command: "help", description: "Show available commands" },
      ]);
    });

    it("continues if setMyCommands fails (best-effort)", async () => {
      grammyMock._api.setMyCommands.mockRejectedValueOnce(new Error("rate limited"));
      await client.start();
      // Should not throw, bot should still start
      expect(client.connected).toBe(true);
      expect(grammyMock._bot.start).toHaveBeenCalled();
    });

    it("sets connected to true", async () => {
      await client.start();
      expect(client.connected).toBe(true);
    });

    it("registers message handler and error handler", async () => {
      await client.start();
      expect(grammyMock._bot.on).toHaveBeenCalledWith("message:text", expect.any(Function));
      expect(grammyMock._bot.catch).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // ── sendMessage() ──

  describe("sendMessage", () => {
    it("returns message_id from response", async () => {
      await client.start();
      const msgId = await client.sendMessage({ chatId: 123, text: "hello" });
      expect(msgId).toBe(42);
    });

    it("passes chatId, text, and opts to bot.api.sendMessage", async () => {
      await client.start();
      await client.sendMessage({ chatId: 123, text: "hello", parseMode: "HTML" });
      expect(grammyMock._api.sendMessage).toHaveBeenCalledWith(123, "hello", { parse_mode: "HTML" });
    });

    it("sends without parse_mode when not specified", async () => {
      await client.start();
      await client.sendMessage({ chatId: 123, text: "hello" });
      expect(grammyMock._api.sendMessage).toHaveBeenCalledWith(123, "hello", {});
    });

    it("throws if bot not started", async () => {
      await expect(client.sendMessage({ chatId: 123, text: "hello" }))
        .rejects.toThrow("Telegram bot not started");
    });
  });

  // ── editMessage() ──

  describe("editMessage", () => {
    it("calls bot.api.editMessageText with correct args", async () => {
      await client.start();
      await client.editMessage({ chatId: 123, messageId: 42, text: "updated" });
      expect(grammyMock._api.editMessageText).toHaveBeenCalledWith(123, 42, "updated", {});
    });

    it("passes parse_mode when specified", async () => {
      await client.start();
      await client.editMessage({ chatId: 123, messageId: 42, text: "updated", parseMode: "HTML" });
      expect(grammyMock._api.editMessageText).toHaveBeenCalledWith(123, 42, "updated", { parse_mode: "HTML" });
    });

    it("throws if bot not started", async () => {
      await expect(client.editMessage({ chatId: 123, messageId: 42, text: "x" }))
        .rejects.toThrow("Telegram bot not started");
    });
  });

  // ── stop() ──

  describe("stop", () => {
    it("sets connected to false and clears bot", async () => {
      await client.start();
      await client.stop();
      expect(client.connected).toBe(false);
      expect(client._bot).toBeNull();
    });
  });
});
