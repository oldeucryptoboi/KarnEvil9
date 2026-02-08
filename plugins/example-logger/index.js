export async function register(api) {
  api.registerHook("before_step", async (context) => {
    api.logger.info(`Step starting: ${context.step_id} (tool: ${context.tool})`);
    return { action: "observe" };
  });

  api.registerHook("after_step", async (context) => {
    api.logger.info(`Step finished: ${context.step_id} (status: ${context.status})`);
    return { action: "observe" };
  });
}
