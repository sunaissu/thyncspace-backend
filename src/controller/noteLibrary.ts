import type { RequestHandler } from "express";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import NoteModel from "../models/note.model.js";
import { NoteStatus } from "../types/_enums.js";
import { toNoteResponse } from "../util/noteResponse.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";
import { withNoteMutationLock } from "../util/noteMutationLock.js";
import { validateNoteContentForType, validateNoteOrganization } from "../util/validation.js";

const ownerId = (req: Parameters<RequestHandler>[0]) => {
  if (!req.user) throw createHttpError(401, "Authentication required");
  return req.user.id;
};
const validId = (id: unknown): string => {
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) throw createHttpError(400, "Invalid note ID");
  return id;
};

export const getTrash: RequestHandler = async (req, res, next) => {
  try {
    const userId = ownerId(req);
    const notes = await NoteModel.find({ owner: userId, status: NoteStatus.Trashed }).sort({ trashedAt: -1 }).exec();
    res.json(notes.map(note => toNoteResponse(note, userId)));
  } catch (error) { next(error); }
};

export const updateOrganization: RequestHandler = async (req, res, next) => {
  try {
    const userId = ownerId(req), noteId = validId(req.params.noteId);
    const changes = validateNoteOrganization(req.body);
    await withNoteMutationLock(noteId, async () => {
      const note = await NoteModel.findOneAndUpdate({ _id: noteId, owner: userId, status: NoteStatus.Active },
        { $set: changes }, { new: true, runValidators: true }).exec();
      if (!note) throw createHttpError(404, "Note not found");
      await invalidateOwnedNotesCache(userId);
      res.json(toNoteResponse(note, userId));
    });
  } catch (error) { next(error); }
};

export const getHistory: RequestHandler = async (req, res, next) => {
  try {
    const note = await NoteModel.findOne({ _id: validId(req.params.noteId), owner: ownerId(req), status: NoteStatus.Active }).select("+history").exec();
    if (!note) throw createHttpError(404, "Note not found");
    res.json([...note.history].reverse().map(version => ({ id: version._id, title: version.title, savedAt: version.savedAt, label: version.label })));
  } catch (error) { next(error); }
};

// Restoring to a fresh private note avoids overwriting concurrent edits and
// prevents old collaboration tokens or buffered updates from reentering it.
export const recoverNote: RequestHandler = async (req, res, next) => {
  try {
    const userId = ownerId(req), noteId = validId(req.params.noteId);
    const versionId = req.body?.versionId === undefined ? undefined : validId(req.body.versionId);
    await withNoteMutationLock(noteId, async () => {
      const source = await NoteModel.findOne({ _id: noteId, owner: userId,
        status: versionId ? NoteStatus.Active : NoteStatus.Trashed }).select("+history").exec();
      if (!source) throw createHttpError(404, "Note not found");
      const version = versionId ? source.history.find(item => item._id?.toString() === versionId) : undefined;
      if (versionId && !version) throw createHttpError(404, "Version not found");
      const content = validateNoteContentForType(version?.content ?? source.content ?? "", source.type);
      const input = { _id: new mongoose.Types.ObjectId(), owner: userId, title: version?.title ?? source.title, type: source.type, content,
        notebook: source.notebook, tags: source.tags, sourcePath: source.sourcePath };
      // Trash restoration consumes the tombstone atomically; version recovery
      // deliberately leaves the original note and history intact.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const [copy] = await NoteModel.create([input], { session });
          if (!versionId) {
            const result = await NoteModel.deleteOne({ _id: noteId, owner: userId, status: NoteStatus.Trashed }, { session }).exec();
            if (result.deletedCount !== 1) throw createHttpError(409, "This note was already restored");
          }
          return copy;
        });
        const recovered = await NoteModel.findOne({ _id: input._id, owner: userId }).exec();
        if (!recovered) throw new Error("Recovery transaction did not complete");
        await invalidateOwnedNotesCache(userId);
        res.status(201).json(toNoteResponse(recovered, userId));
      } finally { await session.endSession(); }
    });
  } catch (error) { next(error); }
};


export const getVersion: RequestHandler = async (req, res, next) => {
  try {
    const note = await NoteModel.findOne({ _id: validId(req.params.noteId), owner: ownerId(req), status: NoteStatus.Active }).select("+history").exec();
    if (!note) throw createHttpError(404, "Note not found");
    const versionId = validId(req.params.versionId);
    const version = note.history.find(item => item._id?.toString() === versionId);
    if (!version) throw createHttpError(404, "Version not found");
    res.json({ id: version._id, title: version.title, content: version.content, type: note.type, savedAt: version.savedAt, label: version.label });
  } catch (error) { next(error); }
};

export const renameVersion: RequestHandler = async (req, res, next) => {
  try {
    const noteId = validId(req.params.noteId), versionId = validId(req.params.versionId), userId = ownerId(req);
    const label = req.body?.label;
    if (typeof label !== "string" || label.trim().length > 80 || /\p{Cc}/u.test(label)) throw createHttpError(400, "Version names must be at most 80 characters without controls");
    await withNoteMutationLock(noteId, async () => {
      const result = await NoteModel.updateOne({ _id: noteId, owner: userId, status: NoteStatus.Active, "history._id": versionId }, { $set: { "history.$.label": label.trim() } }).exec();
      if (result.matchedCount !== 1) throw createHttpError(404, "Version not found");
      res.json({ label: label.trim() });
    });
  } catch (error) { next(error); }
};

export const permanentlyDeleteTrash: RequestHandler = async (req, res, next) => {
  try {
    const noteId = validId(req.params.noteId), userId = ownerId(req);
    if (req.body?.confirmation !== noteId) throw createHttpError(400, "Explicit note confirmation is required");
    await withNoteMutationLock(noteId, async () => {
      const result = await NoteModel.deleteOne({ _id: noteId, owner: userId, status: NoteStatus.Trashed }).exec();
      if (result.deletedCount !== 1) throw createHttpError(404, "Trashed note not found");
      await invalidateOwnedNotesCache(userId);
      res.sendStatus(204);
    });
  } catch (error) { next(error); }
};
