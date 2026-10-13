import type { RequestHandler } from "express";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import Notebook from "../models/sharedNotebook.model.js";
import Note from "../models/note.model.js";
import User from "../models/user.model.js";
import { attachmentId } from "../services/attachments.js";
import { validateShareIdentifier, getShareIdentifierLookupQueries } from "../util/validation.js";
import { withNoteMutationLock } from "../util/noteMutationLock.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";
import { disconnectCollaborator, updateCollaboratorPermission, flushNoteState } from "../collaboration/server.js";
import { PermissionLevel } from "../types/_enums.js";
import { activityEntry, activityPush } from "../util/noteActivity.js";

const actor = (req: Parameters<RequestHandler>[0]) => { if (!req.user) throw createHttpError(401, "Authentication required"); return req.user.id; };
const name = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /\p{Cc}/u.test(value)) throw createHttpError(400, "Notebook names need 1 to 80 characters without controls"); return value.trim(); };
const withLocks = async <T>(ids: string[], action: () => Promise<T>): Promise<T> => ids.length ? withNoteMutationLock(ids[0], () => withLocks(ids.slice(1), action)) : action();
const access = (userId: string) => ({ $or: [{ owner: userId }, { "members.userId": userId }] });

export const listNotebooks: RequestHandler = async (req, res, next) => {
  try {
    const userId = actor(req), cursor = req.query.cursor === undefined ? undefined : attachmentId(req.query.cursor);
    const books = await Notebook.find({ ...access(userId), ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).limit(51).exec();
    const users = await User.find({ _id: { $in: books.map(book => book.owner) } }).select("username").exec(), labels = new Map(users.map(user => [user.id, user.username]));
    const counts = await Note.aggregate([{ $match: { status: "active", sharedNotebookId: { $in: books.map(book => book._id) } } }, { $group: { _id: "$sharedNotebookId", count: { $sum: 1 } } }]).exec();
    const byId = new Map(counts.map(count => [String(count._id), count.count]));
    res.json({ entries: books.slice(0, 50).map(book => ({ id: book.id, name: book.name, owner: String(book.owner), ownerName: labels.get(String(book.owner)) ?? "Unavailable owner", revision: book.revision, permission: String(book.owner) === userId ? "owner" : book.members.find(member => String(member.userId) === userId)?.permission, noteCount: byId.get(book.id) ?? 0 })), nextCursor: books.length > 50 ? books[49].id : null });
  } catch (error) { next(error); }
};
export const getNotebook: RequestHandler = async (req, res, next) => {
  try {
    const userId = actor(req), id = attachmentId(req.params.notebookId), book = await Notebook.findOne({ _id: id, ...access(userId) }).exec();
    if (!book) throw createHttpError(404, "Notebook not found");
    const users = await User.find({ _id: { $in: [book.owner, ...book.members.map(member => member.userId)] } }).select("username").exec(), labels = new Map(users.map(user => [user.id, user.username]));
    const notes = await Note.find({ sharedNotebookId: id, owner: book.owner, status: "active" }).select("title type contentRevision").sort({ title: 1, _id: 1 }).exec();
    res.json({ id, name: book.name, revision: book.revision, owner: String(book.owner), ownerName: labels.get(String(book.owner)) ?? "Unavailable owner", isOwner: String(book.owner) === userId,
      members: book.members.map(member => ({ id: String(member.userId), name: labels.get(String(member.userId)) ?? "Former account", permission: member.permission })),
      notes: notes.map(note => ({ id: note.id, title: note.title, type: note.type, revision: note.contentRevision })) });
  } catch (error) { next(error); }
};
export const createNotebook: RequestHandler = async (req, res, next) => {
  try {
    const owner = actor(req), title = name(req.body?.name), clientId = req.body?.id;
    if (typeof clientId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(clientId)) throw createHttpError(400, "A valid notebook request ID is required");
    const id = await withNoteMutationLock("notebooks-owner:" + owner, async () => {
      const existing = await Notebook.findOne({ owner, clientId: clientId.toLowerCase() }).exec(); if (existing) return existing.id;
      const used = new Set((await Notebook.find({ owner }).select("+slot").exec()).map(book => book.slot));
      const slot = Array.from({ length: 20 }, (_, index) => index).find(index => !used.has(index));
      if (slot === undefined) throw createHttpError(409, "You can own 20 shared notebooks");
      const book = await Notebook.create({ owner, name: title, slot, clientId: clientId.toLowerCase() }); return book.id;
    });
    res.status(201).json({ id });
  } catch (error) { next(error instanceof mongoose.mongo.MongoServerError && error.code === 11000 ? createHttpError(409, "Notebooks changed in another request. Refresh before retrying") : error); }
};

export const changeNotebook: RequestHandler = async (req, res, next) => {
  try {
    const owner = actor(req), id = attachmentId(req.params.notebookId), revision = req.body?.expectedRevision, action = req.body?.action;
    if (!Number.isSafeInteger(revision) || revision < 0) throw createHttpError(428, "Load the notebook before changing it");
    if (!["rename", "member", "remove-member", "attach", "detach", "delete"].includes(action)) throw createHttpError(400, "Unknown notebook action");
    const noteId = action === "attach" || action === "detach" ? attachmentId(req.body.noteId) : undefined;
    let member: { id: string; permission: PermissionLevel } | undefined;
    if (action === "member") {
      const targetMemberId = req.body.memberId === undefined ? undefined : attachmentId(req.body.memberId);
      const identifier = targetMemberId ? "" : validateShareIdentifier(req.body.identifier), permission = req.body.permission;
      if (![PermissionLevel.Editor, PermissionLevel.Viewer].includes(permission)) throw createHttpError(400, "Choose viewer or editor access");
      let user: InstanceType<typeof User> | null = targetMemberId ? await User.findById(targetMemberId).select("emailVerifiedAt").exec() : null;
      for (const query of targetMemberId ? [] : getShareIdentifierLookupQueries(identifier)) { user = await User.findOne(query).collation({ locale: "en", strength: 2 }).select("emailVerifiedAt").exec(); if (user) break; }
      if (!user) throw createHttpError(404, "User not found");
      if (identifier.includes("@") && !user.emailVerifiedAt) throw createHttpError(400, "The recipient must verify that email. You may use a confirmed username instead");
      if (user.id === owner) throw createHttpError(400, "The owner already has full access"); member = { id: user.id, permission };
    }
    const removedMember = action === "remove-member" ? attachmentId(req.body.memberId) : undefined;
    await withNoteMutationLock("notebook:" + id, async () => {
      if (!await Notebook.exists({ _id: id, owner })) throw createHttpError(404, "Owned notebook not found");
      if (noteId && !await Note.exists({ _id: noteId, owner, status: "active" })) throw createHttpError(404, "Owned note not found");
      const ids = (await Note.find({ sharedNotebookId: id, owner, status: "active" }).select("_id").exec()).map(note => note.id);
      const lockedIds = [...new Set([...ids, ...(noteId ? [noteId] : [])])].sort();
      await withLocks(lockedIds, async () => {
        // Preserve accepted live changes before removing or downgrading access.
        if (action !== "rename") for (const targetId of action === "attach" ? [noteId!] : lockedIds) await flushNoteState(targetId);
        const session = await mongoose.startSession();
        let affected: string[] = [], previous: Array<{ id: string; permission: string }> = [], current: Array<{ id: string; permission: string }> = [];
        try {
          await session.withTransaction(async () => {
            const book = await Notebook.findOne({ _id: id, owner }).session(session).exec();
            if (!book) throw createHttpError(404, "Owned notebook not found");
            if (book.revision !== revision) throw createHttpError(409, "The notebook changed. Refresh before editing");
            previous = book.members.map(member => ({ id: String(member.userId), permission: member.permission }));
            if (action === "rename") book.name = name(req.body.name);
            if (member) {
              const found = book.members.find(entry => String(entry.userId) === member!.id);
              if (req.body.memberId !== undefined && !found) throw createHttpError(409, "That person is no longer a member. Refresh before changing access");
              if (found) found.permission = member.permission;
              else { if (book.members.length >= 100) throw createHttpError(409, "A notebook can have 100 members"); book.members.push({ userId: new mongoose.Types.ObjectId(member.id), permission: member.permission }); }
            }
            if (removedMember) { if (!book.members.some(entry => String(entry.userId) === removedMember)) throw createHttpError(404, "Notebook member not found"); book.set("members", book.members.filter(entry => String(entry.userId) !== removedMember)); }
            current = book.members.map(member => ({ id: String(member.userId), permission: member.permission }));
            const contained = await Note.find({ sharedNotebookId: id, owner, status: "active" }).select("_id").session(session).exec();
            affected = contained.map(note => note.id);
            if (affected.some(noteId => !lockedIds.includes(noteId))) throw createHttpError(409, "Notebook contents changed. Refresh before editing");
            if (action === "attach") {
              if (affected.length >= 100) throw createHttpError(409, "A notebook can contain 100 notes");
              const expected = req.body.expectedContentRevision;
              if (!Number.isSafeInteger(expected) || expected < 0) throw createHttpError(428, "Load the saved note before attaching it");
              const result = await Note.updateOne({ _id: noteId, owner, status: "active", sharedNotebookId: null, "sharedWith.0": { $exists: false }, contentRevision: expected }, { $set: { sharedNotebookId: book._id, sharedWith: book.members }, $push: { activity: activityPush(activityEntry("notebook", owner)) } }, { session }).exec();
              if (result.matchedCount !== 1) throw createHttpError(409, "This note changed or already has sharing. Refresh and detach existing sharing before adding it"); affected.push(noteId!);
            } else if (action === "detach") {
              const result = await Note.updateOne({ _id: noteId, owner, status: "active", sharedNotebookId: id }, { $unset: { sharedNotebookId: 1 }, $set: { sharedWith: [] }, $push: { activity: activityPush(activityEntry("notebook", owner)) } }, { session }).exec();
              if (result.matchedCount !== 1) throw createHttpError(404, "Contained note not found"); affected = [noteId!]; current = [];
            } else if (action === "delete") {
              if (req.body.confirmation !== id) throw createHttpError(400, "Confirm the notebook before deleting it");
              await Note.updateMany({ sharedNotebookId: id, owner }, { $unset: { sharedNotebookId: 1 }, $set: { sharedWith: [] }, $push: { activity: activityPush(activityEntry("notebook", owner)) } }, { session }).exec();
              await Notebook.deleteOne({ _id: id, owner, revision }, { session }).exec(); current = []; return;
            } else if (member || removedMember) await Note.updateMany({ sharedNotebookId: id, owner, status: "active" }, { $set: { sharedWith: book.members }, $push: { activity: activityPush(activityEntry("notebook", owner)) } }, { session }).exec();
            book.revision++; await book.save({ session });
          });
        } finally { await session.endSession(); }
        for (const noteId of affected) {
          for (const member of previous) if (!current.some(next => next.id === member.id)) disconnectCollaborator(noteId, member.id);
          for (const member of current) updateCollaboratorPermission(noteId, member.id, member.permission as PermissionLevel);
        }
        await invalidateOwnedNotesCache(owner);
      });
    });
    res.json({ id, removed: action === "delete" });
  } catch (error) { next(error); }
};
