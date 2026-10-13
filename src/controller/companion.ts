import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import * as Companion from "../services/companion.js";

export const manageCompanion: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    if (req.method === "GET") res.json(await Companion.listCompanionGrants(req.user.id));
    else if (req.method === "DELETE") { if (req.body?.confirmation !== req.params.grantId) throw createHttpError(400, "Confirm the connection before revoking it"); await Companion.revokeCompanion(req.user.id, req.params.grantId); res.sendStatus(204); }
    else res.status(201).json(await Companion.createCompanionGrant(req.user.id, req.body ?? {}));
  } catch (error) { next(error); }
};
export const requireCompanion: RequestHandler = async (req, res, next) => {
  try { res.locals.companion = await Companion.authenticateCompanion(req.get("Authorization")); next(); }
  catch (error) { next(error); }
};
export const listCompanion: RequestHandler = async (_req, res, next) => {
  try { res.json(await Companion.listCompanionNotes(res.locals.companion)); } catch (error) { next(error); }
};
export const documentCompanion: RequestHandler = async (req, res, next) => {
  try { res.json(req.method === "PATCH" ? await Companion.updateCompanionNote(res.locals.companion, req.params.noteId, req.body ?? {}) : await Companion.readCompanionNote(res.locals.companion, req.params.noteId)); } catch (error) { next(error); }
};
export const filesCompanion: RequestHandler = async (req, res, next) => {
  try {
    if (!req.params.attachmentId) { res.json(await Companion.companionAttachments(res.locals.companion, req.params.noteId)); return; }
    const file = await Companion.readCompanionAttachment(res.locals.companion, req.params.noteId, req.params.attachmentId);
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'"); res.attachment(file.name); res.type(file.mime); res.send(file.data);
  } catch (error) { next(error); }
};
export const disconnectCompanion: RequestHandler = async (_req, res, next) => {
  try { await Companion.revokeCompanion(res.locals.companion.owner, res.locals.companion.id); res.sendStatus(204); } catch (error) { next(error); }
};
