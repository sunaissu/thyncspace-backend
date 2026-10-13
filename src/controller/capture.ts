import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import { NoteType } from "../types/_enums.js";
import { validateNoteContentForType, validateNoteTitle } from "../util/validation.js";
import { toNoteResponse } from "../util/noteResponse.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";

export const captureNote: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const id = req.body?.captureId;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw createHttpError(400, "Invalid capture ID");
    const title = validateNoteTitle(req.body.title), content = validateNoteContentForType(req.body.text, NoteType.Document);
    const owner = req.user.id, generationKey = `capture:${owner}:${id.toLowerCase()}`;
    let note = await Note.findOne({ owner, generationKey }).exec();
    if (!note) {
      try { note = await Note.create({ owner, title, content, type: NoteType.Document, notebook: "Inbox", generationKey }); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
        note = await Note.findOne({ owner, generationKey }).exec();
        if (!note) throw error;
      }
    }
    if (note.status !== "active" || note.title !== title || note.content !== content) throw createHttpError(409, "This capture was already saved and has since changed. Check Inbox before starting a new capture.");
    await invalidateOwnedNotesCache(owner);
    res.json(toNoteResponse(note, owner));
  } catch (error) { next(error); }
};
