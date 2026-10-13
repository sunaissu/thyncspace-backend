import type { Request, Response } from "express";
import * as authService from "../services/auth.service.js";
import env from "../util/validateEnv.js";
import { SESSION_COOKIE_NAME } from "../util/session.js";
import DeviceSession from "../models/deviceSession.model.js";
import { sessionFingerprint } from "../util/deviceSessions.js";
import { disconnectDeviceSession } from "../collaboration/server.js";

const userResponse = (user: {
  _id: { toString(): string };
  email?: string;
  username: string;
}) => ({
  _id: user._id.toString(),
  email: user.email,
  username: user.username,
});

export const signup = async (req: Request, res: Response) => {
  const user = await authService.signUpUser(req.body ?? {});
  await new Promise<void>((resolve, reject) => {
    req.login(user as Express.User, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  res.status(201).json({
    message: "User created successfully",
    user: userResponse(user),
  });
};

export const login = async (req: Request, res: Response) => {
  const user = await authService.loginUser(req.body ?? {});
  await new Promise<void>((resolve, reject) => {
    req.login(user as Express.User, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  res.status(200).json({ message: "Login successful", user: userResponse(user) });
};

export const logout = async (req: Request, res: Response) => {
  const fingerprint = sessionFingerprint(req.sessionID);
  await DeviceSession.updateOne({ sessionHash: fingerprint, userId: req.user?.id }, { $set: { revokedAt: new Date() } }).exec();
  disconnectDeviceSession(fingerprint);
  await new Promise<void>((resolve, reject) => {
    req.logout((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });

  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.ENVIRONMENT === "production",
  });
  res.status(200).json({ message: "Logged out successfully" });
};
