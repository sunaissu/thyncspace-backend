import { cleanEnv } from "envalid";
import { num, port, str } from "envalid/dist/validators.js";

const env = cleanEnv(process.env, {
  MONGO_CONN: str(),
  MONGO_AUTH_MODE: str({
    choices: ["aws-iam", "password"],
    default: "aws-iam",
  }),
  MONGO_DB_NAME: str(),
  REDIS_URL: str({ default: "" }),
  REDIS_CACHE_TTL_SECONDS: num({ default: 30 }),
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

if (
  env.REDIS_CACHE_TTL_SECONDS < 5 ||
  env.REDIS_CACHE_TTL_SECONDS > 300
) {
  throw new Error("REDIS_CACHE_TTL_SECONDS must be between 5 and 300");
}

if (env.REDIS_URL) {
  try {
    const redisUrl = new URL(env.REDIS_URL);
    if (!["redis:", "rediss:"].includes(redisUrl.protocol)) {
      throw new Error("unsupported protocol");
    }
    const isLocalhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      redisUrl.hostname,
    );
    if (
      env.ENVIRONMENT === "production" &&
      redisUrl.protocol !== "rediss:" &&
      !isLocalhost
    ) {
      throw new Error("TLS is required for remote production Redis");
    }
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.includes("TLS")
        ? error.message
        : "REDIS_URL must be a valid redis:// or rediss:// URL",
    );
  }
}

if (env.ENVIRONMENT === "production") {
  let mongoUrl: URL;

  try {
    mongoUrl = new URL(env.MONGO_CONN);
  } catch {
    throw new Error("MONGO_CONN must be a valid MongoDB connection string");
  }

  if (mongoUrl.protocol !== "mongodb+srv:") {
    throw new Error("Production MONGO_CONN must use mongodb+srv");
  }

  if (env.MONGO_AUTH_MODE === "aws-iam") {
    if (mongoUrl.username || mongoUrl.password) {
      throw new Error("AWS IAM MongoDB authentication must not use URI credentials");
    }

    if (
      mongoUrl.searchParams.get("authSource") !== "$external" ||
      mongoUrl.searchParams.get("authMechanism") !== "MONGODB-AWS"
    ) {
      throw new Error(
        "AWS IAM MongoDB authentication requires authSource=$external and " +
          "authMechanism=MONGODB-AWS",
      );
    }

    if (
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      process.env.AWS_SESSION_TOKEN
    ) {
      throw new Error(
        "AWS IAM production authentication must use the attached role, not AWS environment credentials",
      );
    }
  } else {
    if (!mongoUrl.username || !mongoUrl.password) {
      throw new Error("Password MongoDB authentication requires URI credentials");
    }

    if (
      mongoUrl.searchParams.get("authSource") === "$external" ||
      mongoUrl.searchParams.get("authMechanism") === "MONGODB-AWS"
    ) {
      throw new Error("Password MongoDB authentication cannot use MONGODB-AWS options");
    }
  }
}

export default env;
