import { hasWorkspaceAccess } from "../util/workspaceAccess.js";
import { createHash, randomBytes } from "node:crypto";
import createHttpError from "http-errors";
import Grant from "../models/companionGrant.model.js";
import User from "../models/user.model.js";
import Note from "../models/note.model.js";
import Attachment from "../models/attachment.model.js";
import { attachmentId } from "./attachments.js";
import { archiveClientId } from "./workspaceArchive.js";
import { withNoteMutationLock } from "../util/noteMutationLock.js";
import { validateNoteContentForType, validateNoteTitle } from "../util/validation.js";
import { updateNoteState } from "../collaboration/server.js";
import { NoteType } from "../types/_enums.js";

export interface CompanionScope { id: string; owner: string; noteIds: string[]; attachments: boolean; credentialVersion: number }
export const privateDocuments = (owner: string) => ({ owner, type: "document", status: "active", "sharedWith.0": { $exists: false }, sharedNotebookId: null });
const metadata = (grant: { _id: { toString(): string }; name: string; noteIds: string[]; attachments: boolean; lastUsedAt?: Date | null; expiresAt: Date; createdAt: Date }) => ({ id: grant._id.toString(), name: grant.name, noteIds: grant.noteIds, attachments: grant.attachments, lastUsedAt: grant.lastUsedAt ?? null, expiresAt: grant.expiresAt, createdAt: grant.createdAt });
export async function listCompanionGrants(owner: string) { return (await Grant.find({ owner, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(5).exec()).map(metadata); }
export async function createCompanionGrant(owner: string, input: { name?: unknown; noteIds?: unknown; attachments?: unknown; clientId?: unknown; consent?: unknown }) {
  const clientId = archiveClientId(input.clientId);
  if (input.consent !== true || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || /\p{Cc}/u.test(input.name) || !Array.isArray(input.noteIds) || !input.noteIds.length || input.noteIds.length > 50 || typeof input.attachments !== "boolean") throw createHttpError(400, "Name the connection, select 1–50 private documents, and confirm its access");
  const noteIds = [...new Set(input.noteIds.map(attachmentId))];
  if (await Note.countDocuments({ _id: { $in: noteIds }, ...privateDocuments(owner) }) !== noteIds.length) throw createHttpError(409, "Only your active private documents can be connected. Refresh the list");
  const user = await User.findById(owner).select("+suspendedAt").exec(); if (!user || !hasWorkspaceAccess(user)) throw createHttpError(401, "Account unavailable");
  await Grant.deleteMany({ owner, expiresAt: { $lte: new Date() } }).exec();
  if (await Grant.exists({ owner, clientId })) throw createHttpError(409, "This connection was already created. Tokens are shown once; revoke it and create another if its response was lost");
  const token = "thy_obs_" + randomBytes(32).toString("base64url"), tokenHash = createHash("sha256").update(token).digest("hex");
  for (let slot = 0; slot < 5; slot++) {
    try { const grant = await Grant.create({ owner, clientId, slot, name: input.name.trim(), noteIds, attachments: input.attachments, credentialVersion: user.credentialVersion ?? 0, tokenHash, expiresAt: new Date(Date.now() + 30 * 86400000) }); return { ...metadata(grant), token }; }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error; if (await Grant.exists({ owner, clientId })) throw createHttpError(409, "This connection was already created. Revoke it before creating another"); }
  }
  throw createHttpError(409, "You already have five companion connections. Revoke an unused one first");
}
export async function authenticateCompanion(authorization: unknown): Promise<CompanionScope> {
  if (typeof authorization !== "string" || !/^Bearer thy_obs_[A-Za-z0-9_-]{43}$/.test(authorization)) throw createHttpError(401, "A companion token is required");
  const tokenHash = createHash("sha256").update(authorization.slice(7)).digest("hex");
  const grant = await Grant.findOne({ tokenHash, expiresAt: { $gt: new Date() } }).select("+credentialVersion").exec();
  if (!grant) throw createHttpError(401, "Companion access expired or was revoked");
  const user = await User.findById(grant.owner).select("credentialVersion emailVerifiedAt +suspendedAt").exec();
  if (!user || !hasWorkspaceAccess(user) || (user.credentialVersion ?? 0) !== grant.credentialVersion) throw createHttpError(401, "Companion access expired or was revoked");
  await Grant.updateOne({ _id: grant.id, $or: [{ lastUsedAt: { $exists: false } }, { lastUsedAt: { $lt: new Date(Date.now() - 300000) } }] }, { $set: { lastUsedAt: new Date() } }).exec();
  return { id: grant.id, owner: String(grant.owner), noteIds: grant.noteIds, attachments: grant.attachments, credentialVersion: grant.credentialVersion };
}
export async function revokeCompanion(owner: string, id: unknown) {
  const grantId = attachmentId(id);
  await withNoteMutationLock("companion:" + grantId, async () => { const removed = await Grant.deleteOne({ _id: grantId, owner }).exec(); if (!removed.deletedCount) throw createHttpError(404, "Companion connection not found"); });
}
async function currentScope(scope: CompanionScope) {
  const grant = await Grant.findOne({ _id: scope.id, owner: scope.owner, expiresAt: { $gt: new Date() } }).select("+credentialVersion").exec();
  const user = await User.findById(scope.owner).select("credentialVersion emailVerifiedAt +suspendedAt").exec();
  if (!grant || !user || !hasWorkspaceAccess(user) || grant.credentialVersion !== (user.credentialVersion ?? 0)) throw createHttpError(401, "Companion access expired or was revoked");
  return grant;
}
export async function companionNote(scope: CompanionScope, id: unknown) {
  const noteId = attachmentId(id); if (!scope.noteIds.includes(noteId)) throw createHttpError(404, "Document is outside this connection");
  const note = await Note.findOne({ _id: noteId, ...privateDocuments(scope.owner) }).select("+attachmentRevision").exec();
  if (!note) throw createHttpError(404, "Document is unavailable or now shared. Its local copy remains yours");
  return note;
}
const documentResponse = (note: { _id: { toString(): string }; title: string; content?: string; contentRevision: number; attachmentRevision?: number }) => ({ id: note._id.toString(), title: note.title, content: note.content ?? "", revision: note.contentRevision ?? 0, attachmentRevision: note.attachmentRevision ?? 0 });
export async function listCompanionNotes(scope: CompanionScope) {
  const notes = await Note.find({ _id: { $in: scope.noteIds }, ...privateDocuments(scope.owner) }).select("title contentRevision").exec();
  const indexed = new Map(notes.map(note => [note.id, note]));
  return { connectionId: scope.id, owner: scope.owner, attachments: scope.attachments, notes: scope.noteIds.map(id => { const note = indexed.get(id); return note ? { id, title: note.title, revision: note.contentRevision, available: true } : { id, available: false }; }) };
}
export async function readCompanionNote(scope: CompanionScope, id: unknown) { return documentResponse(await companionNote(scope, id)); }
export async function updateCompanionNote(scope: CompanionScope, id: unknown, input: { title?: unknown; content?: unknown; expectedRevision?: unknown }) {
  const noteId = attachmentId(id), title = validateNoteTitle(input.title), content = validateNoteContentForType(input.content, NoteType.Document);
  if (typeof content !== "string" || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw createHttpError(428, "Load the document revision before syncing");
  return withNoteMutationLock("companion:" + scope.id, async () => {
    await currentScope(scope);
    return withNoteMutationLock(noteId, async () => {
      const note = await companionNote(scope, noteId);
      if (note.contentRevision !== input.expectedRevision) throw createHttpError(409, "Both copies may have changed. Review the current server copy before syncing");
      if (note.content === content && note.title === title) return documentResponse(note);
      await updateNoteState(noteId, scope.owner, NoteType.Document, { title, content }, true);
      return documentResponse(await companionNote(scope, noteId));
    });
  });
}
export async function companionAttachments(scope: CompanionScope, id: unknown) {
  if (!scope.attachments) throw createHttpError(403, "This connection does not include file downloads");
  const note = await companionNote(scope, id);
  const files = await Attachment.find({ references: note.id }).select("+hash").sort({ _id: 1 }).limit(101).exec();
  if (files.length > 100) throw createHttpError(413, "This document has more than 100 files. Download them from the workspace library");
  return files.map(file => ({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, hash: file.hash }));
}
export async function readCompanionAttachment(scope: CompanionScope, id: unknown, attachment: unknown) {
  if (!scope.attachments) throw createHttpError(403, "This connection does not include file downloads");
  const note = await companionNote(scope, id), file = await Attachment.findOne({ _id: attachmentId(attachment), references: note.id }).select("+data +hash").exec();
  if (!file) throw createHttpError(404, "Linked file not found");
  return file;
}
