import { createHmac, timingSafeEqual } from "crypto";
import env from "./validateEnv.js";

const TOKEN_LIFETIME_MS = 30 * 60 * 1000;

export interface CollaborationTokenPayload {
  expiresAt: number;
  noteId: string;
  userId: string;
}

const sign = (payload: string) =>
  createHmac("sha256", env.COLLABORATION_SECRET)
    .update(payload)
    .digest("base64url");

export const createCollaborationToken = (noteId: string, userId: string) => {
  const encodedPayload = Buffer.from(
    JSON.stringify({ noteId, userId, expiresAt: Date.now() + TOKEN_LIFETIME_MS }),
  ).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
};

export const verifyCollaborationToken = (
  token: string,
): CollaborationTokenPayload => {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 2) throw new Error("Invalid collaboration token");
  const [encodedPayload, signature] = tokenParts;
  if (!encodedPayload || !signature) throw new Error("Invalid collaboration token");

  const expected = Buffer.from(sign(encodedPayload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid collaboration token");
  }

  const payload: unknown = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("noteId" in payload) ||
    typeof payload.noteId !== "string" ||
    !("userId" in payload) ||
    typeof payload.userId !== "string" ||
    !("expiresAt" in payload) ||
    typeof payload.expiresAt !== "number" ||
    !payload.noteId ||
    !payload.userId ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= Date.now()
  ) {
    throw new Error("Expired collaboration token");
  }
  return payload as CollaborationTokenPayload;
};
