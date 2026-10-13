import { createHmac } from "node:crypto";
import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import DeviceSession from "../models/deviceSession.model.js";
import env from "./validateEnv.js";

export const sessionFingerprint = (sessionId: string) => createHmac("sha256", env.SESSION_SECRET).update("device-session:" + sessionId).digest("hex");

export async function assertActiveDeviceSession(sessionHash: string, userId: string) {
  if (!/^[a-f0-9]{64}$/.test(sessionHash) || !await DeviceSession.exists({ sessionHash, userId, revokedAt: null, expiresAt: { $gt: new Date() } })) throw createHttpError(401, "Session expired or signed out");
}

export const trackDeviceSession: RequestHandler = async (req, _res, next) => {
  if (!req.user) return next();
  try {
    const sessionHash = sessionFingerprint(req.sessionID);
    const changes = {
      $setOnInsert: { userId: req.user.id, sessionHash, firstSeenAt: new Date(), userAgent: (req.get("user-agent") || "Unknown browser").replace(/\p{Cc}/gu, "").slice(0, 300) },
      $set: { lastSeenAt: new Date(), expiresAt: req.session.cookie.expires ?? new Date(Date.now() + 7 * 86400000) },
    };
    let device;
    try { device = await DeviceSession.findOneAndUpdate({ sessionHash, userId: req.user.id }, changes, { upsert: true, new: true }).exec(); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
      device = await DeviceSession.findOne({ sessionHash, userId: req.user.id }).exec();
    }
    if (!device || device.revokedAt) {
      await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
      throw createHttpError(401, "This session was signed out. Sign in again to continue.");
    }
    next();
  } catch (error) { next(error); }
};
