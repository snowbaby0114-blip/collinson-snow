import { createServer } from "node:http";
import { createSchema, createYoga } from "graphql-yoga";
import { config } from "./config.js";
import { createDatabase } from "./db/client.js";
import { WeatherRepository } from "./db/repository.js";
import type { GraphQLContext } from "./graphql/resolvers.js";
import { resolvers } from "./graphql/resolvers.js";
import { typeDefs } from "./graphql/schema.js";
import { logger } from "./logger.js";
import { OpenMeteoClient } from "./openMeteo/client.js";
import { WeatherService } from "./weather/refresh.js";

const db = createDatabase(config.databasePath);
const repository = new WeatherRepository(db);
const openMeteo = new OpenMeteoClient({
  timeoutMs: config.fetchTimeoutMs,
  retries: config.fetchRetries,
  retryBaseDelayMs: config.fetchRetryBaseDelayMs,
});
const weatherService = new WeatherService(repository, openMeteo, {
  staleAfterMs: config.staleAfterMs,
  forecastDays: config.forecastDays,
});

const yoga = createYoga<object, GraphQLContext>({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: "/graphql",
  context: () => ({ weatherService, repository }),
});

const server = createServer(yoga);

server.listen(config.port, () => {
  logger.info("server started", { port: config.port, url: `http://localhost:${config.port}/graphql` });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });

  server.close(() => {
    db.close();
    logger.info("shutdown complete");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
