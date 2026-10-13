import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import User from "../models/user.model.js";

export const getNoteActivity: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    if (typeof req.params.noteId !== "string" || !/^[a-f0-9]{24}$/i.test(req.params.noteId)) throw createHttpError(400, "Invalid note ID");
    const note = await Note.findOne({ _id: req.params.noteId, owner: req.user.id }).select("+activity owner createdAt").exec();
    if (!note) throw createHttpError(404, "Note not found");
    const ids = [...new Set(note.activity.flatMap(event => [event.actorId, event.targetId]).filter((id): id is string => Boolean(id && /^[a-f0-9]{24}$/i.test(id))))];
    const names = new Map((await User.find({ _id: { $in: ids } }).select("username").exec()).map(user => [user.id, user.username]));
    res.json({ createdAt: note.createdAt, limit: 100, events: [...note.activity].reverse().map(event => ({ id: String(event._id), kind: event.kind, at: event.at,
      actor: event.actorId ? names.get(event.actorId) ?? "Former account" : event.collective ? "Live collaboration" : "Former account",
      target: event.targetId ? names.get(event.targetId) ?? "Former account" : undefined, permission: event.permission,
      sourceNoteId: event.sourceNoteId, sourceVersionId: event.sourceVersionId,
    })) });
  } catch (error) { next(error); }
};
