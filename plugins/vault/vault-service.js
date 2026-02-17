/**
 * Vault engine service — lifecycle management and scheduled jobs.
 */
import { resolve } from "node:path";

/**
 * @param {object} deps
 * @param {import("@karnevil9/vault").VaultManager} deps.manager
 * @param {import("@karnevil9/schemas").PluginLogger} deps.logger
 */
export function createVaultService(deps) {
  const { manager, logger } = deps;
  let ingestionInterval = null;
  let janitorInterval = null;
  let contextInterval = null;

  return {
    name: "vault-engine",

    async start() {
      await manager.init();
      const stats = manager.getStats();
      logger.info("Vault engine initialized", {
        root: manager.getVaultRoot(),
        objects: stats.total_objects,
        links: stats.total_links,
      });

      // Scheduled: context briefing regeneration every 30 minutes
      contextInterval = setInterval(async () => {
        try {
          await manager.generateContext();
          logger.debug("Context briefing regenerated");
        } catch (err) {
          logger.error("Context generation failed", { error: err.message });
        }
      }, 30 * 60 * 1000);

      // Scheduled: janitor every 1 hour
      janitorInterval = setInterval(async () => {
        try {
          const result = await manager.janitor();
          logger.debug("Janitor completed", result);
        } catch (err) {
          logger.error("Janitor failed", { error: err.message });
        }
      }, 60 * 60 * 1000);
    },

    async stop() {
      if (ingestionInterval) clearInterval(ingestionInterval);
      if (janitorInterval) clearInterval(janitorInterval);
      if (contextInterval) clearInterval(contextInterval);
      await manager.close();
      logger.info("Vault engine stopped");
    },

    async health() {
      try {
        const stats = manager.getStats();
        return {
          ok: true,
          detail: `${stats.total_objects} objects, ${stats.total_links} links, ${stats.unclassified_count} unclassified`,
        };
      } catch {
        return { ok: false, detail: "Vault engine error" };
      }
    },
  };
}

/**
 * Create vault routes.
 * @param {() => import("@karnevil9/vault").VaultManager | null} getManager
 */
export function createVaultRoutes(getManager) {
  return {
    "GET /vault/status": async (_req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      res.json(manager.getStats());
    },

    "GET /vault/objects": async (req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      const results = manager.search({
        text: req.query.text,
        object_type: req.query.object_type,
        para_category: req.query.para_category,
        source: req.query.source,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      });
      res.json({ results, total: results.length });
    },

    "GET /vault/links": async (req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      const links = manager.getLinkStore().allLinks();
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
      res.json({ links: links.slice(0, limit), total: links.length });
    },

    "GET /vault/search": async (req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      const results = manager.search({
        text: req.query.q ?? req.query.text,
        object_type: req.query.type,
        para_category: req.query.category,
        source: req.query.source,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
      });
      res.json({ results, total: results.length });
    },

    "GET /vault/context": async (_req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      const briefing = await manager.generateContext();
      res.json(briefing);
    },
  };
}
