import type { RequestHandler } from "express";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import Attachment from "../models/attachment.model.js";
import Quota from "../models/attachmentQuota.model.js";
import Note from "../models/note.model.js";
import { accessibleAttachment, attachmentId, ATTACHMENT_LIMITS, noteAccessFilter, storeAttachment } from "../services/attachments.js";

const owner = (req: Parameters<RequestHandler>[0]) => { if (!req.user) throw createHttpError(401, "Authentication required"); return req.user.id; };
const metadata = (file: { _id: { toString(): string }; name: string; mime: string; bytes: number; owner: unknown; references: string[]; indexedAt?: Date | null; createdAt: Date }) => ({ id: file._id.toString(), name: file.name, mime: file.mime, bytes: file.bytes, owner: String(file.owner), references: file.references, indexedAt: file.indexedAt, createdAt: file.createdAt });

export const listAttachments: RequestHandler = async (req, res, next) => {
  try {
    const userId = owner(req), noteId = req.query.noteId === undefined ? undefined : attachmentId(req.query.noteId);
    const query = req.query.q ?? "";
    if (typeof query !== "string" || query.length > 120) throw createHttpError(400, "Search must be at most 120 characters");
    if (noteId && !await Note.exists({ _id: noteId, ...noteAccessFilter(userId) })) throw createHttpError(404, "Note not found");
    const search = query ? { $or: [{ name: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { ocrText: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] } : {};
    const files = await Attachment.find({ ...(noteId ? { references: noteId } : { owner: userId }), ...search }).sort({ createdAt: -1, _id: -1 }).limit(101).exec();
    const ids = [...new Set(files.flatMap(file => file.references))];
    const accessible = await Note.find({ _id: { $in: ids }, ...noteAccessFilter(userId) }).select("title").exec();
    const titles = new Map(accessible.map(note => [note.id, note.title]));
    const quota = await Quota.findOne({ owner: userId }).lean().exec();
    res.json({ files: files.slice(0, 100).map(file => ({ ...metadata(file), references: (String(file.owner) === userId ? file.references : file.references.filter(id => titles.has(id))).map(id => ({ noteId: id, title: titles.get(id) ?? "Unavailable note" })) })), truncated: files.length > 100, usage: { bytes: quota?.bytes ?? 0, count: quota?.count ?? 0 }, limits: ATTACHMENT_LIMITS });
  } catch (error) { next(error); }
};
export const uploadAttachment: RequestHandler = async (req, res, next) => {
  try { const file = await storeAttachment(owner(req), req.body); if (!file) throw new Error("Attachment upload did not complete"); res.status(201).json(metadata(file)); }
  catch (error) { next(error); }
};
export const attachmentContent: RequestHandler = async (req, res, next) => {
  try {
    const file = await accessibleAttachment(req.params.attachmentId as string, owner(req), true);
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.attachment(file.name); res.type(file.mime); res.send(file.data);
  } catch (error) { next(error); }
};
export const referenceAttachment: RequestHandler = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const userId = owner(req), id = attachmentId(req.params.attachmentId), noteId = attachmentId(req.body?.noteId);
    await session.withTransaction(async () => {
      const file = await Attachment.findById(id).session(session).exec();
      if (!file) throw createHttpError(404, "Attachment not found");
      const isOwner = String(file.owner) === userId;
      const canEdit = await Note.exists({ _id: noteId, ...noteAccessFilter(userId, true) }).session(session);
      if (req.method === "POST") {
        if (!isOwner || !canEdit) throw createHttpError(404, "Owned attachment or editable note not found");
        if (!file.references.includes(noteId) && file.references.length >= ATTACHMENT_LIMITS.references) throw createHttpError(409, "This attachment is already linked to 100 notes");
        // Updating the note in the transaction serializes attachment grants with
        // concurrent permission changes and trash operations.
        await Note.updateOne({ _id: noteId, ...noteAccessFilter(userId, true) }, { $inc: { attachmentRevision: 1 } }, { session, timestamps: false }).exec();
        await Attachment.updateOne({ _id: id, owner: userId }, { $addToSet: { references: noteId } }, { session }).exec();
      } else {
        if (!file.references.includes(noteId)) throw createHttpError(404, "Attachment reference not found");
        if (!isOwner && !canEdit) throw createHttpError(404, "Attachment reference not found");
        if (canEdit) await Note.updateOne({ _id: noteId, ...noteAccessFilter(userId, true) }, { $inc: { attachmentRevision: 1 } }, { session, timestamps: false }).exec();
        await Attachment.updateOne({ _id: id }, { $pull: { references: noteId } }, { session }).exec();
      }
    });
    res.sendStatus(204);
  } catch (error) { next(error); } finally { await session.endSession(); }
};
export const deleteAttachment: RequestHandler = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const userId = owner(req), id = attachmentId(req.params.attachmentId);
    if (req.body?.confirmation !== id) throw createHttpError(400, "Confirm the attachment ID before deleting");
    await session.withTransaction(async () => {
      const file = await Attachment.findOneAndDelete({ _id: id, owner: userId }, { session }).exec();
      if (!file) throw createHttpError(404, "Attachment not found");
      await Quota.updateOne({ owner: userId }, [{ $set: { count: { $max: [0, { $subtract: ["$count", 1] }] }, bytes: { $max: [0, { $subtract: ["$bytes", file.bytes] }] } } }], { session }).exec();
    });
    res.sendStatus(204);
  } catch (error) { next(error); } finally { await session.endSession(); }
};
