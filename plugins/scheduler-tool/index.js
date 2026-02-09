import { scheduleToolManifest, createScheduleToolHandler } from "@jarvis/scheduler";

export async function register(api) {
  const scheduler = api.config.scheduler;
  if (!scheduler) {
    api.logger.warn("No scheduler instance provided in plugin config — schedule tool not registered");
    return;
  }
  api.registerTool(scheduleToolManifest, createScheduleToolHandler(scheduler));
  api.logger.info("Schedule tool registered");
}
