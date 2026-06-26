import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function int(envVar: string | undefined, fallback: number): number {
  const parsed = Number(envVar);
  return envVar && Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 4000),
  databasePath: process.env.DATABASE_PATH ?? join(__dirname, "..", "data", "weather.sqlite"),
  forecastDays: 7,
  staleAfterMs: int(process.env.STALE_AFTER_MS, 3 * 60 * 60 * 1000),
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 10_000),
  fetchRetries: int(process.env.FETCH_RETRIES, 2),
  fetchRetryBaseDelayMs: int(process.env.FETCH_RETRY_BASE_DELAY_MS, 250),
};
