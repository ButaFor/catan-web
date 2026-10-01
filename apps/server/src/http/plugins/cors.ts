import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../config/types.js";

export function registerCors(
  app: FastifyInstance,
  config: ServerConfig,
): void {
  if (!config.corsOrigin) return;
  app.register(cors, { origin: config.corsOrigin });
}
