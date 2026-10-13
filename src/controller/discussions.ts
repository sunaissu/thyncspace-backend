import type { RequestHandler } from "express";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import createHttpError from "http-errors";
import Thread from "../models/discussion.model.js";
import Note from "../models/note.model.js";
import User from "../models/user.model.js";
import { attachmentId, noteAccessFilter } from "../services/attachments.js";

const actor = (req: Parameters<RequestHandler>[0]) => { if (!req.user) throw createHttpError(401, "Authentication required"); return req.user.id; };
const uuid = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw createHttpError(400, "A valid comment request ID is required"); return value.toLowerCase(); };
const input = (body: unknown, mentions: unknown, members: string[]) => {
  if (typeof body !== "string" || !body.trim() || body.length > 4000 || body.includes("\0")) throw createHttpError(400, "Comments need 1 to 4,000 characters without null characters");
  if (!Array.isArray(mentions) || mentions.length > 10) throw createHttpError(400, "Choose up to 10 current collaborators to mention");
  const ids = [...new Set(mentions.map(attachmentId))];
  if (ids.some(id => !members.includes(id))) throw createHttpError(400, "A mentioned person no longer has access to this note");
  return { body: body.trim(), mentions: ids };
};
async function noteAccess(noteId: string, userId: string) {
  const note = await Note.findOne({ _id: noteId, ...noteAccessFilter(userId) }).select("owner sharedWith title").exec();
  if (!note) throw createHttpError(404, "Note not found");
  return note;
}
async function names(ids: string[]) { const users = await User.find({ _id: { $in: ids.filter(id => /^[a-f0-9]{24}$/.test(id)) } }).select("username").exec(); return new Map(users.map(user => [user.id, user.username])); }
export const getDiscussion: RequestHandler = async (req, res, next) => {
  try {
    const userId = actor(req), noteId = attachmentId(req.params.noteId), id = attachmentId(req.params.threadId);
    const note = await noteAccess(noteId, userId);
    const thread = await Thread.findOne({ _id: id, noteId }).select("+posts").exec();
    if (!thread) throw createHttpError(404, "Discussion not found");
    const members = [String(note.owner), ...note.sharedWith.map(member => String(member.userId))];
    const labels = await names([...members, ...thread.posts.flatMap(post => [post.authorId, ...post.mentions])]);
    res.json({ id, noteId, title: note.title, revision: thread.revision, resolved: thread.resolved,
      canEdit: String(note.owner) === userId || note.sharedWith.some(member => String(member.userId) === userId && member.permission === "editor"), isOwner: String(note.owner) === userId,
      members: members.filter(id => labels.has(id)).map(id => ({ id, name: labels.get(id) })),
      posts: thread.posts.map(post => ({ id: post.id, authorId: post.authorId, author: labels.get(post.authorId) ?? "Deleted account", body: post.body, deleted: post.deleted, createdAt: post.createdAt, editedAt: post.editedAt, mentions: post.mentions.map(id => ({ id, name: labels.get(id) ?? "Former collaborator" })) })) });
  } catch (error) { next(error); }
};
export const listDiscussions: RequestHandler = async (req, res, next) => {
  try {
    const userId = actor(req), noteId = req.query.noteId === undefined ? undefined : attachmentId(req.query.noteId), filter = req.query.filter ?? "unresolved";
    if (!["all", "unresolved", "mentions", "replies"].includes(String(filter)) || typeof filter !== "string") throw createHttpError(400, "Unknown discussion filter");
    const cursor = req.query.cursor;
    let before = {};
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || !/^\d{13}:[a-f0-9]{24}$/.test(cursor)) throw createHttpError(400, "Invalid discussion cursor");
      const [time, id] = cursor.split(":"), date = new Date(Number(time));
      before = { $or: [{ updatedAt: { $lt: date } }, { updatedAt: date, _id: { $lt: new mongoose.Types.ObjectId(id) } }] };
    }
    const note = noteId ? await noteAccess(noteId, userId) : null;
    const memberIds = note ? [String(note.owner), ...note.sharedWith.map(member => String(member.userId))] : [];
    const labels = await names(memberIds);
    const rows = await Thread.aggregate([
      { $match: { ...before, ...(noteId ? { noteId: new mongoose.Types.ObjectId(noteId) } : {}), ...(filter === "unresolved" ? { resolved: false } : filter === "mentions" ? { "posts.mentions": userId } : filter === "replies" ? { "posts.authorId": userId, posts: { $elemMatch: { authorId: { $nin: [userId, ""] }, deleted: false } } } : {}) } },
      { $sort: { updatedAt: -1, _id: -1 } },
      { $lookup: { from: "notes", localField: "noteId", foreignField: "_id", as: "note", pipeline: [{ $match: { status: "active", $or: [{ owner: new mongoose.Types.ObjectId(userId) }, { "sharedWith.userId": new mongoose.Types.ObjectId(userId) }] } }, { $project: { title: 1 } }] } },
      { $unwind: "$note" }, { $limit: 51 },
      { $project: { noteId: 1, title: "$note.title", revision: 1, resolved: 1, updatedAt: 1, count: { $size: "$posts" }, excerpt: { $substrCP: [{ $ifNull: [{ $arrayElemAt: ["$posts.body", -1] }, ""] }, 0, 180] } } },
    ]).option({ maxTimeMS: 5000 }).exec();
    const entries = rows.slice(0, 50).map(row => ({ id: String(row._id), noteId: String(row.noteId), title: row.title, revision: row.revision, resolved: row.resolved, updatedAt: row.updatedAt, count: row.count, excerpt: row.excerpt || "Deleted comment" }));
    const last = rows[49];
    res.json({ entries, nextCursor: rows.length > 50 ? `${new Date(last.updatedAt).getTime()}:${last._id}` : null,
      canEdit: Boolean(note && (String(note.owner) === userId || note.sharedWith.some(member => String(member.userId) === userId && member.permission === "editor"))),
      members: memberIds.filter(id => labels.has(id)).map(id => ({ id, name: labels.get(id) })) });
  } catch (error) { next(error); }
};
export const changeDiscussion: RequestHandler = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const userId = actor(req), noteId = attachmentId(req.params.noteId), action = req.body?.action;
    if ((action === "create") !== !req.params.threadId || !["create", "reply", "edit", "delete-post", "resolve", "reopen", "remove"].includes(action)) throw createHttpError(400, "Unknown discussion action");
    let threadId = req.params.threadId ? attachmentId(req.params.threadId) : "";
    await session.withTransaction(async () => {
      const note = await Note.findOneAndUpdate({ _id: noteId, ...noteAccessFilter(userId, true) }, { $inc: { discussionRevision: 1 } }, { session, new: true, timestamps: false }).exec();
      if (!note) throw createHttpError(404, "Editable note not found");
      const members = [String(note.owner), ...note.sharedWith.map(member => String(member.userId))];
      if (action === "create" && !req.params.threadId) {
        const clientId = uuid(req.body.id), value = input(req.body.body, req.body.mentions, members);
        const fingerprint = createHash("sha256").update(JSON.stringify([userId, value.body, [...value.mentions].sort()])).digest("hex");
        const previous = await Thread.findOne({ noteId, clientId }).select("+fingerprint").session(session).exec();
        if (previous) { if (previous.fingerprint !== fingerprint) throw createHttpError(409, "This request ID was already used for another comment"); threadId = previous.id; return; }
        if (await Thread.countDocuments({ noteId }).session(session).exec() >= 100) throw createHttpError(409, "A note can have 100 discussions. Remove an old discussion first");
        const [thread] = await Thread.create([{ noteId, clientId, fingerprint, posts: [{ id: clientId, authorId: userId, ...value, createdAt: new Date() }] }], { session }); threadId = thread.id; return;
      }
      const thread = await Thread.findOne({ _id: threadId, noteId }).select("+posts").session(session).exec();
      if (!thread) throw createHttpError(404, "Discussion not found");
      const revision = req.body.expectedRevision;
      if (!Number.isSafeInteger(revision) || revision < 0) throw createHttpError(428, "Load the discussion before changing it");
      // Replaying a successfully committed reply is safe, including a lost response.
      if (action === "reply") {
        const id = uuid(req.body.id), value = input(req.body.body, req.body.mentions, members), existing = thread.posts.find(post => post.id === id);
        if (existing) { if (existing.authorId !== userId || existing.body !== value.body || JSON.stringify([...existing.mentions].sort()) !== JSON.stringify([...value.mentions].sort())) throw createHttpError(409, "This reply ID was already used"); return; }
      }
      if (thread.revision !== revision) throw createHttpError(409, "This discussion changed. Refresh before posting or editing");
      if (action === "remove") {
        if (String(note.owner) !== userId || req.body.confirmation !== threadId) throw createHttpError(403, "Only the note owner can confirm removing this discussion");
        await Thread.deleteOne({ _id: threadId, revision }, { session }).exec(); return;
      }
      if (action === "reply") {
        if (thread.resolved) throw createHttpError(409, "Reopen this discussion before replying");
        if (thread.posts.length >= 50) throw createHttpError(409, "This discussion has 50 comments. Start another discussion");
        thread.posts.push({ id: uuid(req.body.id), authorId: userId, ...input(req.body.body, req.body.mentions, members), createdAt: new Date(), deleted: false });
      } else if (action === "resolve" || action === "reopen") thread.resolved = action === "resolve";
      else if (action === "edit" || action === "delete-post") {
        const post = thread.posts.find(post => post.id === uuid(req.body.id));
        if (!post || post.deleted || post.authorId !== userId) throw createHttpError(404, "Your comment was not found");
        if (action === "edit") Object.assign(post, input(req.body.body, req.body.mentions, members), { editedAt: new Date() });
        else Object.assign(post, { body: "", mentions: [], deleted: true, editedAt: new Date() });
      } else throw createHttpError(400, "Unknown discussion action");
      thread.revision++; await thread.save({ session });
    });
    res.json({ id: threadId, removed: action === "remove" });
  } catch (error) { next(error); } finally { await session.endSession(); }
};
