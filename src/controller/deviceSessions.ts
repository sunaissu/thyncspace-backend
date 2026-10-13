import type { RequestHandler } from "express";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import DeviceSession from "../models/deviceSession.model.js";
import { sessionFingerprint } from "../util/deviceSessions.js";
import { disconnectDeviceSession } from "../collaboration/server.js";

export const listDeviceSessions: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const current = sessionFingerprint(req.sessionID);
    const devices = await DeviceSession.find({ userId: req.user.id, revokedAt: null, expiresAt: { $gt: new Date() } }).select("+sessionHash").sort({ lastSeenAt: -1 }).limit(100).exec();
    res.json(devices.map(device => ({ id: device.id, current: device.sessionHash === current, userAgent: device.userAgent, firstSeenAt: device.firstSeenAt, lastSeenAt: device.lastSeenAt, expiresAt: device.expiresAt })));
  } catch (error) { next(error); }
};

export const revokeDeviceSession: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const id = req.params.deviceId;
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id) || !mongoose.isValidObjectId(id)) throw createHttpError(400, "Invalid device ID");
    const device = await DeviceSession.findOneAndUpdate({ _id: id, userId: req.user.id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true }).select("+sessionHash").exec();
    if (!device) throw createHttpError(404, "Session not found");
    disconnectDeviceSession(device.sessionHash);
    const current = device.sessionHash === sessionFingerprint(req.sessionID);
    if (current) await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.json({ signedOut: true, current });
  } catch (error) { next(error); }
};
