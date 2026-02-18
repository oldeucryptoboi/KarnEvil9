/**
 * Vault engine service — lifecycle management and scheduled jobs.
 */

/**
 * @param {object} deps
 * @param {import("@karnevil9/vault").VaultManager} deps.manager
 * @param {import("@karnevil9/schemas").PluginLogger} deps.logger
 */
export function createVaultService(deps) {
  const { manager, logger } = deps;
  let fastInterval = null;
  let slowInterval = null;
  let insightsInterval = null;
  let pipelineRunning = false;

  async function runFastPipeline() {
    if (pipelineRunning) return;
    pipelineRunning = true;
    try {
      const dz = await manager.processDropZone();
      if (dz.files_processed > 0) {
        logger.info("DropZone processed files", {
          files_processed: dz.files_processed,
          items_created: dz.items_created,
        });
        // Classify newly ingested items
        try {
          await manager.classify({ limit: 200 });
        } catch (clErr) {
          logger.error("Post-ingest classification failed", { error: clErr.message });
        }
      }
      await manager.generateContext();
      logger.debug("Fast pipeline completed (dropzone + classify + context)");
    } catch (err) {
      logger.error("Fast pipeline failed", { error: err.message });
    } finally {
      pipelineRunning = false;
    }
  }

  async function runSlowPipeline() {
    if (pipelineRunning) return;
    pipelineRunning = true;
    try {
      const result = await manager.janitor();
      logger.debug("Janitor completed", result);
      await manager.generateDashboard();
      logger.debug("Dashboard regenerated after janitor");
    } catch (err) {
      logger.error("Slow pipeline failed", { error: err.message });
    } finally {
      pipelineRunning = false;
    }
  }

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

      // Generate initial context so _Meta/current-context.md exists for before_plan hook
      try {
        await manager.generateContext();
        logger.debug("Initial context briefing generated");
      } catch (err) {
        logger.warn("Initial context generation failed", { error: err.message });
      }

      // Fast loop (15 min): dropzone scan + classify new items + context regen
      fastInterval = setInterval(runFastPipeline, 15 * 60 * 1000);

      // Slow loop (60 min): janitor + dashboard regen
      slowInterval = setInterval(runSlowPipeline, 60 * 60 * 1000);

      // Daily (24 hr): insights generation
      insightsInterval = setInterval(async () => {
        try {
          await manager.generateInsights();
          logger.debug("Daily insights generated");
        } catch (err) {
          logger.error("Insights generation failed", { error: err.message });
        }
      }, 24 * 60 * 60 * 1000);
    },

    async stop() {
      if (fastInterval) clearInterval(fastInterval);
      if (slowInterval) clearInterval(slowInterval);
      if (insightsInterval) clearInterval(insightsInterval);
      await manager.close();
      logger.info("Vault engine stopped");
    },

    async health() {
      try {
        const stats = manager.getStats();
        const embeddingCount = manager.getVectorStore().size();
        return {
          ok: true,
          detail: `${stats.total_objects} objects, ${stats.total_links} links, ${stats.unclassified_count} unclassified, ${embeddingCount} embeddings`,
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
      const stats = manager.getStats();
      const embeddingCount = manager.getVectorStore().size();
      res.json({ ...stats, embedding_count: embeddingCount });
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

    "GET /vault/dashboard": async (_req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      const data = manager.getDashboardData();
      res.json(data);
    },

    "GET /vault/insights": async (_req, res) => {
      const manager = getManager();
      if (!manager) return res.status(503).json({ error: "Vault engine not initialized" });
      try {
        const filePath = await manager.generateInsights();
        res.json({ file_path: filePath, status: "generated" });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  };
}
