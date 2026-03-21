import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { register } from "./index.js";

// ── Mock grammY globally (imported by telegram-client.js) ──

vi.mock("grammy", () => {
  const api = {
    setMyCommands: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  };
  const bot = {
    api,
    on: vi.fn(),
    catch: vi.fn(),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    Bot: vi.fn(() => bot),
    _bot: bot,
    _api: api,
  };
});

// ── Helper: mock PluginApi ──

function makeApi(overrides = {}) {
  const routes = new Map();
  const tools = [];
  const hooks = [];
  const services = [];

  return {
    config: {
      sessionFactory: vi.fn().mockResolvedValue({ session_id: "s-123", status: "running" }),
      journal: null, // no journal by default
      apiBaseUrl: "http://localhost:3100",
      apiToken: "test-token",
      ...overrides,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerRoute: vi.fn((method, path, handler) => {
      routes.set(`${method} ${path}`, handler);
    }),
    registerTool: vi.fn((manifest, handler) => {
      tools.push({ manifest, handler });
    }),
    registerHook: vi.fn((name, handler) => {
      hooks.push({ name, handler });
    }),
    registerService: vi.fn((service) => {
      services.push(service);
    }),
    // Test helpers
    _routes: routes,
    _tools: tools,
    _hooks: hooks,
    _services: services,
    _getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
}

// ── Helper: capture onMessage handler from TelegramClient ──
// Since TelegramClient is real (not mocked), we need to trigger messages
// through the service start → bot.on("message:text") path.
// Instead, we'll test the routes and the wiring.

describe("register (index.js)", () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    // Reset shared grammy mock state between tests
    const grammy = await import("grammy");
    grammy._api.setMyCommands.mockClear();
    grammy._api.sendMessage.mockClear().mockResolvedValue({ message_id: 1 });
    grammy._api.editMessageText.mockClear();
    grammy._api.sendChatAction.mockClear();
    grammy._bot.on.mockClear();
    grammy._bot.catch.mockClear();
    grammy._bot.start.mockClear();
    grammy._bot.stop.mockClear();

    // Set required env
    process.env.TELEGRAM_BOT_TOKEN = "test:token";
    delete process.env.TELEGRAM_ALLOWED_USERS;
    delete process.env.TELEGRAM_DM_POLICY;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // ── DM policy resolution ──

  describe("DM policy resolution", () => {
    it("defaults to pairing when no allowed users set", async () => {
      const api = makeApi();
      await register(api);

      const statusHandler = api._getRoute("GET", "status");
      const res = { json: vi.fn() };
      statusHandler({}, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    });

    it("defaults to allowlist when TELEGRAM_ALLOWED_USERS is set", async () => {
      process.env.TELEGRAM_ALLOWED_USERS = "12345";
      const api = makeApi();
      await register(api);

      const statusHandler = api._getRoute("GET", "status");
      const res = { json: vi.fn() };
      statusHandler({}, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ dmPolicy: "allowlist" }),
      );
    });

    it("respects explicit TELEGRAM_DM_POLICY override", async () => {
      process.env.TELEGRAM_ALLOWED_USERS = "12345";
      process.env.TELEGRAM_DM_POLICY = "pairing";
      const api = makeApi();
      await register(api);

      const statusHandler = api._getRoute("GET", "status");
      const res = { json: vi.fn() };
      statusHandler({}, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ dmPolicy: "pairing" }),
      );
    });
  });

  // ── Route registration ──

  describe("route registration", () => {
    it("registers all expected routes", async () => {
      const api = makeApi();
      await register(api);

      const registeredRoutes = api.registerRoute.mock.calls.map(([m, p]) => `${m} ${p}`);
      expect(registeredRoutes).toContain("GET status");
      expect(registeredRoutes).toContain("GET conversations");
      expect(registeredRoutes).toContain("GET pairing");
      expect(registeredRoutes).toContain("POST pairing/:code/approve");
      expect(registeredRoutes).toContain("POST pairing/:code/deny");
    });
  });

  // ── Status route ──

  describe("GET status", () => {
    it("includes pendingPairings count", async () => {
      const api = makeApi();
      await register(api);

      const statusHandler = api._getRoute("GET", "status");
      const res = { json: vi.fn() };
      statusHandler({}, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ pendingPairings: 0 }),
      );
    });
  });

  // ── Pairing routes ──

  describe("GET pairing", () => {
    it("returns empty pending list initially", async () => {
      const api = makeApi();
      await register(api);

      const handler = api._getRoute("GET", "pairing");
      const res = { json: vi.fn() };
      handler({}, res);

      expect(res.json).toHaveBeenCalledWith({ pending: [] });
    });
  });

  describe("POST pairing/:code/approve", () => {
    it("returns 404 for unknown code", async () => {
      const api = makeApi();
      await register(api);

      const handler = api._getRoute("POST", "pairing/:code/approve");
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { code: "ZZZZZZ" } }, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("not found") }),
      );
    });
  });

  describe("POST pairing/:code/deny", () => {
    it("returns 404 for unknown code", async () => {
      const api = makeApi();
      await register(api);

      const handler = api._getRoute("POST", "pairing/:code/deny");
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { code: "ZZZZZZ" } }, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("not found") }),
      );
    });
  });

  // ── Stub mode (no token) ──

  describe("stub mode (no token)", () => {
    it("registers stub routes when no token", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const api = makeApi({ telegramBotToken: undefined });
      await register(api);

      // Status stub
      const statusHandler = api._getRoute("GET", "status");
      const res = { json: vi.fn() };
      statusHandler({}, res);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ connected: false, mode: "disabled" }),
      );
    });

    it("registers pairing stub routes when no token", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const api = makeApi({ telegramBotToken: undefined });
      await register(api);

      // Pairing list stub
      const pairingHandler = api._getRoute("GET", "pairing");
      const res1 = { json: vi.fn() };
      pairingHandler({}, res1);
      expect(res1.json).toHaveBeenCalledWith({ pending: [] });

      // Approve stub
      const approveHandler = api._getRoute("POST", "pairing/:code/approve");
      const res2 = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      approveHandler({}, res2);
      expect(res2.status).toHaveBeenCalledWith(503);
    });
  });

  // ── Message handler: pairing flow ──
  // bot.on("message:text") is registered inside telegramClient.start(),
  // which is called by the service's start(). So we need to start the service first.

  async function registerAndStart(api) {
    await register(api);
    const service = api._services.find((s) => s.name === "telegram-connection");
    await service.start();
    const grammy = await import("grammy");
    // bot.on is called during start(); find the handler
    const call = grammy._bot.on.mock.calls.find(([event]) => event === "message:text");
    return { grammy, botOnHandler: call?.[1] };
  }

  describe("message handler (pairing flow)", () => {
    it("sends pairing code to unknown user in pairing mode", async () => {
      // No allowed users → pairing mode
      const api = makeApi();
      const { grammy, botOnHandler } = await registerAndStart(api);
      expect(botOnHandler).toBeDefined();
      grammy._api.sendMessage.mockClear();

      // Simulate incoming message from unknown user
      await botOnHandler({
        chat: { id: 999 },
        from: { id: 777 },
        message: { text: "hello", date: Math.floor(Date.now() / 1000) },
      });

      // Should have sent a pairing code message
      expect(grammy._api.sendMessage).toHaveBeenCalledWith(
        999,
        expect.stringContaining("pairing code"),
        expect.any(Object),
      );
    });

    it("silently rejects unknown user in allowlist mode", async () => {
      process.env.TELEGRAM_ALLOWED_USERS = "12345";
      const api = makeApi();
      const { grammy, botOnHandler } = await registerAndStart(api);
      grammy._api.sendMessage.mockClear();

      await botOnHandler({
        chat: { id: 999 },
        from: { id: 777 },
        message: { text: "hello", date: Math.floor(Date.now() / 1000) },
      });

      // Should NOT have sent any message (silent reject)
      expect(grammy._api.sendMessage).not.toHaveBeenCalled();
    });

    it("allows pre-approved user to send messages", async () => {
      process.env.TELEGRAM_ALLOWED_USERS = "12345";
      const api = makeApi();
      const { grammy, botOnHandler } = await registerAndStart(api);
      grammy._api.sendMessage.mockClear();

      await botOnHandler({
        chat: { id: 100 },
        from: { id: 12345 },
        message: { text: "do something", date: Math.floor(Date.now() / 1000) },
      });

      // Should have sent a confirmation message (the task confirmation prompt)
      expect(grammy._api.sendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining("Run this task?"),
        expect.any(Object),
      );
    });
  });

  // ── Service registration ──

  describe("service registration", () => {
    it("registers telegram-connection service", async () => {
      const api = makeApi();
      await register(api);

      expect(api.registerService).toHaveBeenCalledWith(
        expect.objectContaining({ name: "telegram-connection" }),
      );
    });
  });

  // ── Tool registration ──

  describe("tool registration", () => {
    it("registers send-telegram-message tool", async () => {
      const api = makeApi();
      await register(api);

      expect(api.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "send-telegram-message" }),
        expect.any(Function),
      );
    });
  });

  // ── Hook registration ──

  describe("hook registration", () => {
    it("registers after_session_end hook", async () => {
      const api = makeApi();
      await register(api);

      expect(api.registerHook).toHaveBeenCalledWith("after_session_end", expect.any(Function));
    });
  });
});
