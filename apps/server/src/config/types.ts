export type NodeEnvironment = "development" | "test" | "production";

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type ServerConfig = {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  corsOrigin?: string;
};

export type AuthConfig = {
  sessionCookieName: string;
  sessionTtlMs: number;
  oauthStateTtlSeconds: number;
  secureCookies: boolean;
};

export type DatabaseConfig = {
  url?: string;
  mockDbPath: string;
};

export type AppConfig = {
  server: ServerConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  googleOAuth?: GoogleOAuthConfig;
};
