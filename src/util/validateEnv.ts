import { cleanEnv } from "envalid";
import { port, str } from "envalid/dist/validators";

const env = cleanEnv(process.env, {
  MONGO_CONN: str(),
  MONGO_DB_NAME: str(),
  PORT: port({ default: 5000 }),
  HOST: str({ default: "127.0.0.1" }),
  SESSION_SECRET: str(),
  COLLABORATION_SECRET: str({
    default: process.env.SESSION_SECRET ?? "",
  }),
  GOOGLE_AUTH_CLIENT_ID: str(),
  GOOGLE_AUTH_CLIENT_SECRET: str(),
  GOOGLE_CALLBACK_URL: str(),
  ENVIRONMENT: str({
    choices: ["development", "test", "production"],
    default: "development",
  }),
  CLIENT_URL: str(),
  TRUST_PROXY: str({ default: "loopback" }),
  CSRF_MODE: str({ choices: ["origin", "token"], default: "token" }),
});

if (env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters");
}

if (env.COLLABORATION_SECRET.length < 32) {
  throw new Error("COLLABORATION_SECRET must contain at least 32 characters");
}

if (
  env.ENVIRONMENT === "production" &&
  env.COLLABORATION_SECRET === env.SESSION_SECRET
) {
  throw new Error(
    "COLLABORATION_SECRET must be different from SESSION_SECRET in production",
  );
}

for (const [name, value] of [
  ["CLIENT_URL", env.CLIENT_URL],
  ["GOOGLE_CALLBACK_URL", env.GOOGLE_CALLBACK_URL],
] as const) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
    if (url.username || url.password || url.hash) {
      throw new Error("credentials and fragments are not allowed");
    }
    if (env.ENVIRONMENT === "production" && url.protocol !== "https:") {
      throw new Error("HTTPS is required in production");
    }
    if (name === "CLIENT_URL" && value.replace(/\/$/, "") !== url.origin) {
      throw new Error("CLIENT_URL must contain only an origin");
    }
  } catch {
    throw new Error(
      `${name} must be a valid HTTP(S) URL without credentials or fragments` +
        (env.ENVIRONMENT === "production" ? " and must use HTTPS" : ""),
    );
  }
}

if (!/^[a-zA-Z0-9_-]{1,63}$/.test(env.MONGO_DB_NAME)) {
  throw new Error("MONGO_DB_NAME contains unsupported characters");
}

if (env.ENVIRONMENT === "production" && env.MONGO_CONN.startsWith("mongodb://")) {
  const mongoParameters = new URLSearchParams(env.MONGO_CONN.split("?", 2)[1] ?? "");
  const tlsEnabled = ["true", "1"].includes(
    mongoParameters.get("tls") ?? mongoParameters.get("ssl") ?? "",
  );
  if (!tlsEnabled) {
    throw new Error("Production mongodb:// connections must enable TLS");
  }
}

export default env;
