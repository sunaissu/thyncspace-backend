import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import User from "../models/user.model.js";
import UserAuth from "../models/userAuth.model.js";
import { validateEmail } from "../util/validation.js";
import { mailConfigured, queueAuthMail } from "../services/authMail.js";
import { changePassword, consumeAccountAction } from "../services/accountSecurity.js";

export const securityStatus: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const [user, auth] = await Promise.all([User.findById(req.user.id).exec(), UserAuth.findOne({ userId: req.user.id }).exec()]);
    if (!user || !auth) throw createHttpError(401, "Account is unavailable");
    res.json({ provider: auth.authProvider, verified: Boolean(user.emailVerifiedAt), emailDeliveryAvailable: mailConfigured() });
  } catch (error) { next(error); }
};
export const requestPasswordReset: RequestHandler = async (req, res, next) => {
  try {
    const email = validateEmail(req.body?.email);
    if (!mailConfigured()) throw createHttpError(503, "Email recovery is not configured for this service. Contact the service operator.");
    // Queue before looking up an account: existing/unknown/Google emails follow
    // the same request path, response, and database write shape.
    await queueAuthMail("reset", email);
    res.json({ message: "If this address belongs to a local account, a recovery link will arrive. Check spam and allow a few minutes." });
  } catch (error) { next(error); }
};
export const requestVerification: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    if (!mailConfigured()) throw createHttpError(503, "Email verification is not configured for this service. Contact the service operator.");
    await queueAuthMail("verify", req.user.email, req.user.id);
    res.json({ message: "If verification is needed, a link will arrive at your account email." });
  } catch (error) { next(error); }
};
export const confirmAccountAction: RequestHandler = async (req, res, next) => {
  try {
    await consumeAccountAction(req.body?.purpose, req.body?.token, req.body?.password);
    res.json({ message: req.body.purpose === "reset" ? "Password changed. Existing sessions are signed out; sign in with your new password." : "Email verified. You can return to ThyncSpace." });
  } catch (error) { next(error); }
};
export const updatePassword: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    await changePassword(req.user.id, req.user.credentialVersion ?? 0, req.body?.currentPassword, req.body?.newPassword);
    req.session.destroy(() => undefined);
    res.json({ message: "Password changed. Sign in again with the new password." });
  } catch (error) { next(error); }
};
