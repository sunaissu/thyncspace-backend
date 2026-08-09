import { randomBytes, timingSafeEqual } from "crypto";
import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import env from "./validateEnv";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CLIENT_ORIGIN = new URL(env.CLIENT_URL).origin;

const tokensMatch = (expected: string, actual: string) => {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
};

export const issueCsrfToken: RequestHandler = (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("base64url");
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ token: req.session.csrfToken });
};

export const requireCsrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const requestOrigin = req.get("origin");
  if (!requestOrigin || requestOrigin !== CLIENT_ORIGIN) {
    return next(createHttpError(403, "Request origin is not allowed"));
  }

  if (env.CSRF_MODE === "origin") return next();

  const expectedToken = req.session.csrfToken;
  const actualToken = req.get("x-csrf-token");
  if (
    !expectedToken ||
    !actualToken ||
    !tokensMatch(expectedToken, actualToken)
  ) {
    return next(createHttpError(403, "Invalid CSRF token"));
  }

  return next();
};
