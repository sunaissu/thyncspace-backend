import type { RequestHandler } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import createHttpError from "http-errors";
import PrivacyRequest from "../models/privacyRequest.model.js";
import User from "../models/user.model.js";
import { accountExport } from "../services/accountExport.js";

const response = (request: { _id: { toString(): string }; status: string; requestedAt: Date; cancelledAt?: Date | null } | null) => request ? ({ id: request._id.toString(), status: request.status, requestedAt: request.requestedAt, cancelledAt: request.cancelledAt }) : null;

export const exportAccount: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="thyncspace-account.jsonl"');
    await pipeline(Readable.from(accountExport(req.user.id)), res);
  } catch (error) { if (!res.headersSent && !res.destroyed) next(error); }
};

export const getDeletionRequest: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    res.json(response(await PrivacyRequest.findOne({ owner: req.user.id }).exec()));
  } catch (error) { next(error); }
};

export const changeDeletionRequest: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const owner = req.user.id;
    if (req.method === "DELETE") {
      const value = await PrivacyRequest.findOneAndUpdate({ owner, status: "pending" }, { $set: { status: "cancelled", cancelledAt: new Date() } }, { new: true }).exec();
      res.json(response(value ?? await PrivacyRequest.findOne({ owner }).exec()));
      return;
    }
    const user = await User.findById(owner).exec();
    if (!user) throw createHttpError(401, "Account is unavailable");
    if (req.body?.confirmation !== user.username) throw createHttpError(400, "Type your current username to request deletion");
    // Repeated submission keeps the original request date. A cancelled request
    // can be reopened, with the unique owner index preventing duplicate queues.
    let value = await PrivacyRequest.findOneAndUpdate({ owner, status: "cancelled" }, { $set: { status: "pending", requestedAt: new Date() }, $unset: { cancelledAt: 1 } }, { new: true }).exec();
    if (!value) {
      try { value = await PrivacyRequest.findOneAndUpdate({ owner }, { $setOnInsert: { status: "pending", requestedAt: new Date() } }, { new: true, upsert: true }).exec(); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
        value = await PrivacyRequest.findOne({ owner }).exec();
      }
    }
    res.json(response(value));
  } catch (error) { next(error); }
};
