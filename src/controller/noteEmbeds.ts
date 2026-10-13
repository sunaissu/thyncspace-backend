import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import { attachmentId, noteAccessFilter } from "../services/attachments.js";
import { activityEntry, activityPush } from "../util/noteActivity.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";

const actor = (req: Parameters<RequestHandler>[0]) => { if (!req.user) throw createHttpError(401, "Authentication required"); return req.user.id; };
const revisionFilter = (revision: number) => revision === 0 ? { $or: [{ embedRevision: 0 }, { embedRevision: { $exists: false } }] } : { embedRevision: revision };
async function list(noteId: string, userId: string) {
  const host = await Note.findOne({ _id: noteId, ...noteAccessFilter(userId) }).select("owner sharedWith linkedSources embedRevision").exec();
  if (!host) throw createHttpError(404, "Note not found");
  const sources = await Note.find({ _id: { $in: host.linkedSources.map(source => source.noteId) }, ...noteAccessFilter(userId) }).select("title type contentRevision").exec();
  const byId = new Map(sources.map(source => [source.id, source]));
  return { revision: host.embedRevision ?? 0, canEdit: String(host.owner) === userId || host.sharedWith.some(member => String(member.userId) === userId && member.permission === "editor"), entries: host.linkedSources.map(link => {
    const source = byId.get(link.noteId);
    return { noteId: link.noteId, available: Boolean(source), title: source?.title ?? "Unavailable source", type: source?.type, sourceRevision: source?.contentRevision, reviewedRevision: link.sourceRevision, stale: Boolean(source && source.contentRevision !== link.sourceRevision) };
  }) };
}
export const listEmbeds: RequestHandler = async (req, res, next) => {
  try { res.json(await list(attachmentId(req.params.noteId), actor(req))); } catch (error) { next(error); }
};
export const previewEmbed: RequestHandler = async (req, res, next) => {
  try {
    const userId = actor(req), noteId = attachmentId(req.params.noteId), sourceId = attachmentId(req.params.sourceId);
    if (!await Note.exists({ _id: noteId, ...noteAccessFilter(userId), "linkedSources.noteId": sourceId })) throw createHttpError(404, "Linked source not found");
    const source = await Note.findOne({ _id: sourceId, ...noteAccessFilter(userId) }).select("title type content contentRevision updatedAt").exec();
    if (!source) throw createHttpError(404, "Linked source not found");
    res.json({ noteId: source.id, title: source.title, type: source.type, content: source.content ?? "", revision: source.contentRevision, updatedAt: source.updatedAt });
  } catch (error) { next(error); }
};
export const updateEmbeds: RequestHandler = async (req, res, next) => {
  try {
    const userId = actor(req), noteId = attachmentId(req.params.noteId), sourceId = attachmentId(req.body?.sourceId), revision = req.body?.expectedRevision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw createHttpError(428, "Load current linked sources before changing them");
    if (sourceId === noteId) throw createHttpError(400, "Choose another note as the source");
    const host = await Note.findOne({ _id: noteId, ...noteAccessFilter(userId, true) }).select("linkedSources embedRevision owner").exec();
    if (!host) throw createHttpError(404, "Editable note not found");
    if ((host.embedRevision ?? 0) !== revision) throw createHttpError(409, "Linked sources changed. Refresh before editing");
    const entries = host.linkedSources.map(link => ({ noteId: link.noteId, sourceRevision: link.sourceRevision })), index = entries.findIndex(link => link.noteId === sourceId);
    const action = req.body?.action;
    if (action === "remove") { if (index < 0) throw createHttpError(404, "Linked source not found"); entries.splice(index, 1); }
    else if (action === "add" || action === "review") {
      const source = await Note.findOne({ _id: sourceId, ...noteAccessFilter(userId) }).select("contentRevision").exec();
      if (!source) throw createHttpError(404, "Accessible source not found");
      if (action === "add") {
        if (index >= 0) throw createHttpError(409, "This source is already linked");
        if (entries.length >= 20) throw createHttpError(409, "A note may have at most 20 linked sources");
        entries.push({ noteId: sourceId, sourceRevision: source.contentRevision });
      } else {
        if (index < 0) throw createHttpError(404, "Linked source not found");
        if (req.body?.expectedSourceRevision !== source.contentRevision) throw createHttpError(409, "The source changed again. Refresh its preview before marking it reviewed");
        entries[index].sourceRevision = source.contentRevision;
      }
    } else throw createHttpError(400, "Unknown linked-source action");
    const result = await Note.updateOne({ $and: [{ _id: noteId, ...noteAccessFilter(userId, true) }, revisionFilter(revision)] }, { $set: { linkedSources: entries }, $inc: { embedRevision: 1 }, $push: { activity: activityPush(activityEntry("embed", userId, { sourceNoteId: sourceId })) } }, { runValidators: true }).exec();
    if (result.modifiedCount !== 1) throw createHttpError(409, "Linked sources or permissions changed. Refresh before editing");
    await invalidateOwnedNotesCache(String(host.owner)); res.json(await list(noteId, userId));
  } catch (error) { next(error); }
};
