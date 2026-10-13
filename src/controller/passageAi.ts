import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import { attachmentId, noteAccessFilter } from "../services/attachments.js";
import { aiAvailability, generatePassageResult } from "../services/passageAi.js";

export const aiSettings: RequestHandler = (_req, res) => { res.json({ enabled: aiAvailability(), provider: "OpenAI", limit: 8000 }); };
export const passageAction: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    if (!aiAvailability()) throw createHttpError(503, "AI actions are not enabled for this workspace");
    const userId = req.user.id, noteId = attachmentId(req.params.noteId), { action, start, end, excerpt, expectedRevision, consent } = req.body ?? {};
    if (consent !== true) throw createHttpError(400, "Review and explicitly consent to sending this passage");
    if (!["summarize", "variables"].includes(action)) throw createHttpError(400, "Choose a supported AI action");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 8000 || typeof excerpt !== "string" || !excerpt.trim() || excerpt.length !== end - start || excerpt.includes("\0")) throw createHttpError(400, "Select 1 to 8,000 characters from the saved document");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw createHttpError(428, "Load the source revision before sending");
    const note = await Note.findOne({ _id: noteId, type: "document", ...noteAccessFilter(userId) }).select("title content contentRevision").exec();
    if (!note) throw createHttpError(404, "Document not found");
    if (note.contentRevision !== expectedRevision || (note.content ?? "").slice(start, end) !== excerpt) throw createHttpError(409, "The source changed. Reload it and review the passage before sending");
    const result = await generatePassageResult(action, excerpt);
    // Recheck access before returning output after the external request.
    const current = await Note.findOne({ _id: noteId, type: "document", ...noteAccessFilter(userId) }).select("contentRevision").exec();
    if (!current) throw createHttpError(404, "Access to the source was removed while the AI action ran");
    res.json({ action, result, source: { noteId, title: note.title, revision: expectedRevision, start, end, excerpt, changed: current.contentRevision !== expectedRevision } });
  } catch (error) { next(error); }
};
