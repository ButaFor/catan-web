import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig, NodeEnvironment } from "./types.js";

const DEFAULT_MOCK_DB_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/mock-db.json",
);

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const rawEnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGIN: optionalString,
    DATABASE_URL: optionalString,
    MOCK_DB_PATH: optionalString,
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REDIRECT_URI: optionalUrl,
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
    OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 10),
  })
  .superRefine((environment, context) => {
    const googleValues = [
      environment.GOOGLE_CLIENT_ID,
      environment.GOOGLE_CLIENT_SECRET,
      environment.GOOGLE_REDIRECT_URI,
    ];
    const configuredCount = googleValues.filter(
      (value) => value !== undefined,
    ).length;

    if (configuredCount > 0 && configuredCount < googleValues.length) {
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_ID"],
        message:
          "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must be configured together",
      });
    }
  });

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = rawEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean);
    const uniqueFields = [...new Set(fields)];
    throw new Error(
      `Invalid server configuration${uniqueFields.length ? ` (${uniqueFields.join(", ")})` : ""}`,
    );
  }

  const values = result.data;
  const googleOAuth =
    values.GOOGLE_CLIENT_ID &&
    values.GOOGLE_CLIENT_SECRET &&
    values.GOOGLE_REDIRECT_URI
      ? {
          clientId: values.GOOGLE_CLIENT_ID,
          clientSecret: values.GOOGLE_CLIENT_SECRET,
          redirectUri: values.GOOGLE_REDIRECT_URI,
        }
      : undefined;

  const nodeEnv: NodeEnvironment = values.NODE_ENV;
  return {
    server: {
      nodeEnv,
      host: values.HOST,
      port: values.PORT,
      ...(values.CORS_ORIGIN ? { corsOrigin: values.CORS_ORIGIN } : {}),
    },
    auth: {
      sessionCookieName: "catan_session",
      sessionTtlMs: values.SESSION_TTL_SECONDS * 1000,
      oauthStateTtlSeconds: values.OAUTH_STATE_TTL_SECONDS,
      secureCookies: nodeEnv === "production",
    },
    database: {
      ...(values.DATABASE_URL ? { url: values.DATABASE_URL } : {}),
      mockDbPath: values.MOCK_DB_PATH ?? DEFAULT_MOCK_DB_PATH,
    },
    ...(googleOAuth ? { googleOAuth } : {}),
  };
}
