import cronParser from "cron-parser";
const { parseExpression } = cronParser;

const INTERVAL_REGEX = /^(\d+)(s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a human-friendly interval string into milliseconds.
 * Supported formats: "30s", "5m", "1h", "2d"
 */
export function parseInterval(interval: string): number {
  const match = INTERVAL_REGEX.exec(interval.trim());
  if (!match) {
    throw new Error(`Invalid interval format: "${interval}". Expected format: <number><s|m|h|d> (e.g. "30s", "5m", "1h", "2d")`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (value <= 0) {
    throw new Error(`Interval value must be positive, got ${value}`);
  }
  const ms = UNIT_MS[unit];
  if (ms === undefined) {
    throw new Error(`Unknown interval unit: "${unit}"`);
  }
  const result = value * ms;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Interval value overflows safe integer range: ${value}${unit} = ${result}ms`);
  }
  return result;
}

/**
 * Compute the next occurrence of a cron expression after the given date.
 * Returns an ISO 8601 string.
 */
export function computeNextCron(expression: string, timezone?: string, from?: Date): string {
  const options: { currentDate?: Date; tz?: string } = {};
  if (from) options.currentDate = from;
  if (timezone) options.tz = timezone;
  const interval = parseExpression(expression, options);
  return interval.next().toISOString();
}

/**
 * Compute the next run time for an interval-based trigger.
 * If `lastRunAt` is provided, the next run is `lastRunAt + intervalMs`.
 * Otherwise, if `startAt` is provided, use that as the base.
 * Falls back to `now + intervalMs`.
 */
export function computeNextInterval(intervalStr: string, lastRunAt?: string, startAt?: string): string {
  const ms = parseInterval(intervalStr);
  const now = Date.now();
  if (lastRunAt) {
    const lastRunMs = new Date(lastRunAt).getTime();
    if (!Number.isFinite(lastRunMs)) {
      throw new Error(`Invalid lastRunAt date: "${lastRunAt}"`);
    }
    const next = lastRunMs + ms;
    return new Date(Math.max(next, now)).toISOString();
  }
  if (startAt) {
    const start = new Date(startAt).getTime();
    if (!Number.isFinite(start)) {
      throw new Error(`Invalid startAt date: "${startAt}"`);
    }
    if (start > now) return new Date(start).toISOString();
    // Advance to next future occurrence
    const elapsed = now - start;
    const periods = Math.ceil(elapsed / ms);
    return new Date(start + periods * ms).toISOString();
  }
  return new Date(now + ms).toISOString();
}
