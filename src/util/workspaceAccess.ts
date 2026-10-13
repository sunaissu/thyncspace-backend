import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import User from "../models/user.model.js";
import env from "./validateEnv.js";
export const hasWorkspaceAccess = (user: { suspendedAt?: Date | null; emailVerifiedAt?: Date | null }) => !user.suspendedAt && (!env.REQUIRE_VERIFIED_EMAIL || Boolean(user.emailVerifiedAt));
export async function assertWorkspaceAccess(owner: string) {
  const user = await User.findById(owner).select("emailVerifiedAt +suspendedAt").exec();
  if (!user || user.suspendedAt) throw createHttpError(401, "Account unavailable");
  if (!hasWorkspaceAccess(user)) throw createHttpError(403, "Verify your email in Account security before opening the workspace. Account export and deletion remain available.");
}
export const requireWorkspaceAccess: RequestHandler = async (req, _res, next) => { if (!req.user) throw createHttpError(401, "Authentication required"); await assertWorkspaceAccess(req.user.id); next(); };
