import bcrypt from "bcrypt";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import User from "../models/user.model.js";
import UserAuth from "../models/userAuth.model.js";
import AuthAction from "../models/authAction.model.js";
import AuthMail from "../models/authMail.model.js";
import Device from "../models/deviceSession.model.js";
import { emailKey, mailConfigured, queueAuthMail, tokenHash } from "./authMail.js";
import { validateLoginPassword, validateRegistrationPassword } from "../util/validation.js";
import { disconnectUserSessions } from "../collaboration/server.js";
import { cacheKeys, deleteCachedKeys } from "../util/cache.js";

const invalidLink = () => createHttpError(400, "This link is invalid, expired, or already used. Request a new one.");
const versionQuery = (version: number) => version === 0 ? { $or: [{ credentialVersion: 0 }, { credentialVersion: { $exists: false } }] } : { credentialVersion: version };

export async function consumeAccountAction(purpose: unknown, token: unknown, password?: unknown) {
  if ((purpose !== "reset" && purpose !== "verify") || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw invalidLink();
  const hash = tokenHash(token), now = new Date();
  if (!await AuthAction.exists({ tokenHash: hash, purpose, expiresAt: { $gt: now } })) throw invalidLink();
  const passwordHash = purpose === "reset" ? await bcrypt.hash(validateRegistrationPassword(password), 12) : undefined;
  const session = await mongoose.startSession();
  let owner = "";
  try {
    await session.withTransaction(async () => {
      const action = await AuthAction.findOne({ tokenHash: hash, purpose, expiresAt: { $gt: new Date() } }).select("+email").session(session).exec();
      if (!action) throw invalidLink();
      owner = String(action.userId);
      const user = await User.findOneAndUpdate({ _id: owner, suspendedAt: null, email: action.email, ...versionQuery(action.credentialVersion) }, {
        $set: { emailVerifiedAt: new Date() }, ...(purpose === "reset" ? { $inc: { credentialVersion: 1 } } : {}),
      }, { new: true, session }).select("+email").exec();
      if (!user) throw invalidLink();
      const auth = await UserAuth.findOne({ userId: owner, ...(purpose === "reset" ? { authProvider: "local" } : {}) }).session(session).exec();
      if (!auth) throw invalidLink();
      if (purpose === "reset") {
        await UserAuth.updateOne({ _id: auth._id }, { $set: { password: passwordHash } }, { session }).exec();
        await invalidateCredentials(owner, user.email, session);
      } else await AuthAction.deleteMany({ userId: owner, purpose: "verify" }, { session }).exec();
    });
  } finally { await session.endSession(); }
  if (purpose === "reset") disconnectUserSessions(owner);
  await deleteCachedKeys(cacheKeys.sessionUser(owner));
}

async function invalidateCredentials(owner: string, email: string, session: mongoose.ClientSession) {
  await AuthAction.deleteMany({ userId: owner }, { session }).exec();
  await AuthMail.deleteMany({ emailKey: emailKey(email), kind: { $in: ["reset", "verify"] } }, { session }).exec();
  await Device.updateMany({ userId: owner }, { $set: { revokedAt: new Date() } }, { session }).exec();
  if (mailConfigured()) await queueAuthMail("changed", email, owner, session);
}

export async function changePassword(owner: string, credentialVersion: number, currentPassword: unknown, newPassword: unknown) {
  const current = validateLoginPassword(currentPassword), next = validateRegistrationPassword(newPassword);
  const auth = await UserAuth.findOne({ userId: owner, authProvider: "local" }).select("+password").exec();
  if (!auth?.password || !await bcrypt.compare(current, auth.password)) throw createHttpError(400, "Current password is incorrect or this account uses Google sign-in");
  if (current === next) throw createHttpError(400, "Choose a different new password");
  const passwordHash = await bcrypt.hash(next, 12), session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const user = await User.findOneAndUpdate({ _id: owner, suspendedAt: null, ...versionQuery(credentialVersion) }, { $inc: { credentialVersion: 1 } }, { new: true, session }).select("+email").exec();
      if (!user) throw createHttpError(409, "Account credentials changed. Sign in again.");
      const updated = await UserAuth.updateOne({ _id: auth._id, password: auth.password }, { $set: { password: passwordHash } }, { session }).exec();
      if (updated.modifiedCount !== 1) throw createHttpError(409, "Account credentials changed. Sign in again.");
      await invalidateCredentials(owner, user.email, session);
    });
  } finally { await session.endSession(); }
  disconnectUserSessions(owner);
  await deleteCachedKeys(cacheKeys.sessionUser(owner));
}
