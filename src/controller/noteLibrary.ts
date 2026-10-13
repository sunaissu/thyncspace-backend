import Attachment from "../models/attachment.model.js";
import { copyAttachmentReferences } from "../services/attachments.js";
import { activityEntry, activityPush } from "../util/noteActivity.js";
import type { RequestHandler } from "express";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import NoteModel from "../models/note.model.js";
import Daily from "../models/dailyNote.model.js";
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

export const getStorageUsage: RequestHandler = async (req, res, next) => {
  try {
    const userId = ownerId(req);
    const [usage] = await NoteModel.aggregate([
      { $match: { owner: new mongoose.Types.ObjectId(userId) } },
      { $project: {
        title: 1, type: 1, status: 1,
        contentBytes: { $binarySize: { $ifNull: ["$content", ""] } },
        collaborationBytes: { $binarySize: { $ifNull: ["$collaborationState", ""] } },
        historyBytes: { $reduce: { input: { $ifNull: ["$history", []] }, initialValue: 0,
          in: { $add: ["$$value", { $binarySize: { $ifNull: ["$$this.content", ""] } }] } } },
      } },
      { $addFields: { totalBytes: { $add: ["$contentBytes", "$collaborationBytes", "$historyBytes"] } } },
      { $facet: {
        totals: [{ $group: { _id: null, notes: { $sum: 1 }, totalBytes: { $sum: "$totalBytes" },
          contentBytes: { $sum: "$contentBytes" }, historyBytes: { $sum: "$historyBytes" }, collaborationBytes: { $sum: "$collaborationBytes" },
          trashBytes: { $sum: { $cond: [{ $eq: ["$status", NoteStatus.Trashed] }, "$totalBytes", 0] } } } }],
        largest: [{ $sort: { totalBytes: -1, _id: 1 } }, { $limit: 20 }],
      } },
    ]);
    res.json({ totals: usage?.totals[0] ?? { notes: 0, totalBytes: 0, contentBytes: 0, historyBytes: 0, collaborationBytes: 0, trashBytes: 0 }, largest: usage?.largest ?? [], noteLimitBytes: 1024 * 1024 });
  } catch (error) { next(error); }
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
        { $set: changes, $push: { activity: activityPush(activityEntry("organize", userId)) } }, { new: true, runValidators: true }).exec();
      if (!note) throw createHttpError(404, "Note not found");
      await invalidateOwnedNotesCache(userId);
      res.json(toNoteResponse(note, userId));
    });
  } catch (error) { next(error); }
};

export const bulkOrganization: RequestHandler = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const userId = ownerId(req);
    const action = req.body?.action;
    let affected = 0;
    if (action === "move" || action === "archive") {
      if (!Array.isArray(req.body.noteIds) || !req.body.noteIds.length || req.body.noteIds.length > 100) throw createHttpError(400, "Select 1 to 100 owned notes");
      const ids = [...new Set<string>(req.body.noteIds.map(validId))];
      const organization = validateNoteOrganization({ notebook: action === "move" ? req.body.notebook : "", tags: [], ...(action === "archive" ? { isArchived: req.body.isArchived } : {}) });
      if (action === "archive" && typeof req.body.isArchived !== "boolean") throw createHttpError(400, "Archive setting must be a boolean");
      const changes = action === "move" ? { notebook: organization.notebook } : { isArchived: organization.isArchived };
      await session.withTransaction(async () => {
        const filter = { _id: { $in: ids }, owner: userId, status: NoteStatus.Active };
        if (await NoteModel.countDocuments(filter).session(session).exec() !== ids.length) throw createHttpError(404, "One or more owned notes are no longer available");
        const result = await NoteModel.updateMany(filter, { $set: changes, $push: { activity: activityPush(activityEntry("organize", userId)) } }, { session, runValidators: true }).exec();
        affected = result.matchedCount;
      });
    } else if (action === "rename-tag") {
      const { tags: [from] } = validateNoteOrganization({ notebook: "", tags: [req.body.from] });
      const { tags: [to] } = validateNoteOrganization({ notebook: "", tags: [req.body.to] });
      await session.withTransaction(async () => {
        const result = await NoteModel.updateMany({ owner: userId, status: NoteStatus.Active, tags: from }, [
          { $set: { tags: { $setUnion: [{ $setDifference: ["$tags", { $literal: [from] }] }, { $literal: [to] }] }, activity: { $slice: [{ $concatArrays: [{ $ifNull: ["$activity", []] }, { $literal: [activityEntry("organize", userId)] }] }, -100] } } },
        ], { session }).exec();
        affected = result.matchedCount;
      });
    } else throw createHttpError(400, "Unknown organization action");
    await invalidateOwnedNotesCache(userId);
    res.json({ affected });
  } catch (error) { next(error); }
  finally { await session.endSession(); }
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
        status: versionId ? NoteStatus.Active : NoteStatus.Trashed }).select("+history +activity").exec();
      if (!source) throw createHttpError(404, "Note not found");
      const version = versionId ? source.history.find(item => item._id?.toString() === versionId) : undefined;
      if (versionId && !version) throw createHttpError(404, "Version not found");
      const content = validateNoteContentForType(version?.content ?? source.content ?? "", source.type);
      const input = { _id: new mongoose.Types.ObjectId(), owner: userId, title: version?.title ?? source.title, type: source.type, content,
        notebook: source.notebook, tags: source.tags, sourcePath: source.sourcePath, linkedSources: source.linkedSources, activity: [...(versionId ? [] : source.activity ?? []), activityEntry("restore", userId, { sourceNoteId: noteId, sourceVersionId: versionId })].slice(-100) };
      // Trash restoration consumes the tombstone atomically; version recovery
      // deliberately leaves the original note and history intact.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const [copy] = await NoteModel.create([input], { session });
          await copyAttachmentReferences(noteId, String(input._id), !versionId, session);
          if (!versionId) {
            await Daily.updateOne({ owner: userId, noteId }, { $set: { noteId: input._id } }, { session }).exec();
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
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const result = await NoteModel.deleteOne({ _id: noteId, owner: userId, status: NoteStatus.Trashed }, { session }).exec();
          if (result.deletedCount !== 1) throw createHttpError(404, "Trashed note not found");
          await Attachment.updateMany({ references: noteId }, { $pull: { references: noteId } }, { session }).exec();
        });
      } finally { await session.endSession(); }
      await invalidateOwnedNotesCache(userId);
      res.sendStatus(204);
    });
  } catch (error) { next(error); }
};
