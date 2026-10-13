import { summarizeError } from "./errorLogging.js";
import { createClient } from "@redis/client";
import env from "./validateEnv.js";

type CacheStatus = "connecting" | "disabled" | "ready" | "unavailable";

const CACHE_KEY_PREFIX = "thyncspace:cache:v1:";
const MAX_CACHE_VALUE_BYTES = 2 * 1024 * 1024;
const REDIS_RETRY_DELAY_MS = 30_000;

const client = env.REDIS_URL
  ? createClient({
      url: env.REDIS_URL,
      keyPrefix: CACHE_KEY_PREFIX,
      commandsQueueMaxLength: 100,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: false,
      },
    })
  : null;

let cacheStatus: CacheStatus = client ? "unavailable" : "disabled";
let connectPromise: Promise<void> | null = null;
let lastErrorLogAt = 0;
let retryTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
const inFlightLoads = new Map<string, Promise<unknown>>();
const invalidationVersions = new Map<string, number>();

const reportError = (error: unknown) => {
  const now = Date.now();
  if (now - lastErrorLogAt < 60_000) return;
  lastErrorLogAt = now;
  console.error("Redis cache unavailable; using MongoDB directly", summarizeError(error));
};

const scheduleRetry = () => {
  if (!client || shuttingDown || retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectCache();
  }, REDIS_RETRY_DELAY_MS);
  retryTimer.unref();
};

if (client) {
  client.on("error", reportError);
  client.on("end", () => {
    if (shuttingDown) return;
    cacheStatus = "unavailable";
    scheduleRetry();
  });
}

export const cacheKeys = {
  ownedNotes: (userId: string) => `notes:owner:${userId}`,
  sessionUser: (userId: string) => `session-user:${userId}`,
};

export const getCacheStatus = () => cacheStatus;

export const connectCache = async () => {
  if (!client || shuttingDown || client.isReady) return;
  if (connectPromise) return connectPromise;

  cacheStatus = "connecting";
  connectPromise = client
    .connect()
    .then(() => {
      cacheStatus = "ready";
      console.log("Redis cache connected");
    })
    .catch((error: unknown) => {
      cacheStatus = "unavailable";
      reportError(error);
      scheduleRetry();
    })
    .finally(() => {
      connectPromise = null;
    });
  return connectPromise;
};

export const disconnectCache = () => {
  shuttingDown = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (client?.isOpen) client.destroy();
  cacheStatus = client ? "unavailable" : "disabled";
};

const getCachedJson = async <Value>(key: string): Promise<Value | undefined> => {
  if (!client?.isReady) {
    if (client && !connectPromise) void connectCache();
    return undefined;
  }

  try {
    const cached = await client.get(key);
    if (cached === null) return undefined;
    return JSON.parse(cached) as Value;
  } catch (error) {
    reportError(error);
    return undefined;
  }
};

export const setCachedJson = async (
  key: string,
  value: unknown,
  ttlSeconds = env.REDIS_CACHE_TTL_SECONDS,
) => {
  if (!client?.isReady) return false;

  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_VALUE_BYTES) {
      return false;
    }
    await client.setEx(key, ttlSeconds, serialized);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
};

export const deleteCachedKeys = async (...keys: string[]) => {
  if (keys.length === 0) return false;
  keys.forEach((key) => {
    invalidationVersions.set(key, (invalidationVersions.get(key) ?? 0) + 1);
    inFlightLoads.delete(key);
  });
  if (!client?.isReady) return false;
  try {
    await client.del(keys);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
};

export const invalidateOwnedNotesCache = (ownerId: string) =>
  deleteCachedKeys(cacheKeys.ownedNotes(ownerId));

export const readThroughCachedJson = async <Value>(
  key: string,
  load: () => Promise<Value>,
  ttlSeconds = env.REDIS_CACHE_TTL_SECONDS,
): Promise<Value> => {
  const cached = await getCachedJson<Value>(key);
  if (cached !== undefined) return cached;

  const existing = inFlightLoads.get(key) as Promise<Value> | undefined;
  if (existing) return existing;

  const versionBeforeLoad = invalidationVersions.get(key) ?? 0;
  const pending = load()
    .then(async (value) => {
      if (
        value !== null &&
        value !== undefined &&
        (invalidationVersions.get(key) ?? 0) === versionBeforeLoad
      ) {
        await setCachedJson(key, value, ttlSeconds);
      }
      return value;
    })
    .finally(() => {
      if (inFlightLoads.get(key) === pending) inFlightLoads.delete(key);
    });
  inFlightLoads.set(key, pending);
  return pending;
};
