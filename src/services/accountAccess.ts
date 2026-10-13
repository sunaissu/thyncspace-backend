import mongoose from "mongoose";
import createHttpError from "http-errors";
import User from "../models/user.model.js";
import Device from "../models/deviceSession.model.js";
import Grant from "../models/companionGrant.model.js";
import AuthAction from "../models/authAction.model.js";
import AuthMail from "../models/authMail.model.js";
import Schedule from "../models/noteSchedule.model.js";
import { emailKey } from "./authMail.js";
import { disconnectUserSessions } from "../collaboration/server.js";
import { cacheKeys, deleteCachedKeys } from "../util/cache.js";

// Operator-only, while every API/worker instance is stopped. No HTTP route.
export async function changeAccountAccess(id: string, username: string, version: number, action: string, actor: string, reason: string) {
  if (!/^[a-f0-9]{24}$/i.test(id) || !Number.isSafeInteger(version) || version < 0 || !["suspend", "resume"].includes(action) || typeof username !== "string" || !username || typeof actor !== "string" || !actor.trim() || actor.length > 100 || typeof reason !== "string" || !reason.trim() || reason.length > 500 || /\p{Cc}/u.test(actor + reason)) throw createHttpError(400, "Provide the account ID, exact username, credential version, action, operator name and reason");
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    const user = await User.findById(id).select("+email +suspendedAt").session(session).exec();
    if (!user || user.username !== username) throw createHttpError(404, "Account confirmation does not match");
    if ((user.credentialVersion ?? 0) !== version || Boolean(user.suspendedAt) !== (action === "resume")) throw createHttpError(409, "Account state changed or already matches. Inspect it again");
    const now = new Date();
    await User.updateOne({ _id: id }, { $set: { suspendedAt: action === "suspend" ? now : null }, $inc: { credentialVersion: 1 }, $push: { accessHistory: { $each: [{ at: now, action, actor: actor.trim(), reason: reason.trim() }], $slice: -100 } } }, { session }).exec();
    await Device.updateMany({ userId: id }, { $set: { revokedAt: now } }, { session }).exec();
    await Grant.deleteMany({ owner: id }, { session }).exec();
    await AuthAction.deleteMany({ userId: id }, { session }).exec();
    await AuthMail.deleteMany({ emailKey: emailKey(user.email) }, { session }).exec();
    if (action === "suspend") await Schedule.updateMany({ owner: id, isActive: true }, { $set: { isActive: false, error: "Account access is suspended. Review this schedule before resuming." } }, { session }).exec();
  }); } finally { await session.endSession(); }
  disconnectUserSessions(id); await deleteCachedKeys(cacheKeys.sessionUser(id));
}
