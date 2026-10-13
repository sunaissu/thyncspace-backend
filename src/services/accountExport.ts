import CompanionGrant from "../models/companionGrant.model.js";
import { ArchiveImport, ArchiveItem } from "../models/archiveImport.model.js";
import SharedNotebook from "../models/sharedNotebook.model.js";
import Discussion from "../models/discussion.model.js";
import Reminders from "../models/reminders.model.js";
import Attachment from "../models/attachment.model.js";
import AuthAction from "../models/authAction.model.js";
import AuthMail from "../models/authMail.model.js";
import { emailKey } from "./authMail.js";
import User from "../models/user.model.js";
import Note from "../models/note.model.js";
import UserAuth from "../models/userAuth.model.js";
import Workspace from "../models/workspace.model.js";
import Daily from "../models/dailyNote.model.js";
import Schedule from "../models/noteSchedule.model.js";
import Device from "../models/deviceSession.model.js";
import PrivacyRequest from "../models/privacyRequest.model.js";
import { toNoteResponse } from "../util/noteResponse.js";
import createHttpError from "http-errors";

// JSON Lines keeps server memory bounded. Credentials, cookies, session hashes,
// CRDT internals and other accounts' private organization are never exported.
export async function* accountExport(owner: string) {
  const profile = await User.findById(owner).select("username +email emailVerifiedAt +suspendedAt +accessHistory createdAt updatedAt").lean().exec();
  if (!profile) throw createHttpError(401, "Account is unavailable");
  let count = 0;
  const line = (kind: string, data: unknown) => { count++; return JSON.stringify({ kind, data }) + "\n"; };
  yield line("manifest", { format: "thyncspace-account", version: 1, startedAt: new Date().toISOString(), consistency: "Each record reflects its read time. Save pending edits before exporting." });
  yield line("profile", profile);
  yield line("companionConnections", await CompanionGrant.find({ owner }).select("name noteIds attachments lastUsedAt expiresAt createdAt").lean().exec());
  yield line("archiveImport", await ArchiveImport.findById(owner).select("-__v").lean().exec());
  const staged = ArchiveItem.find({ owner }).select("+payload -__v").cursor();
  try { for await (const record of staged) yield line("stagedArchiveRecord", record); } finally { await staged.close(); }
  yield line("authentication", await UserAuth.findOne({ userId: owner }).select("authProvider createdAt updatedAt -_id").lean().exec());
  yield line("reminders", await Reminders.findOne({ owner }).select("-__v").lean().exec());
  yield line("workspace", await Workspace.findOne({ owner }).select("-__v").lean().exec());
  yield line("deletionRequest", await PrivacyRequest.findOne({ owner }).select("-__v").lean().exec());
  const notebooks = SharedNotebook.find({ $or: [{ owner }, { "members.userId": owner }] }).select("-__v").cursor();
  try { for await (const book of notebooks) yield line("sharedNotebook", { id: book.id, name: book.name, owner: book.owner, members: book.members.filter(member => String(book.owner) === owner || String(member.userId) === owner) }); } finally { await notebooks.close(); }
  const attachments = Attachment.find({ owner }).select("+data +ocrText").cursor();
  try { for await (const file of attachments) yield line("attachment", { id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, references: file.references, ocrText: file.ocrText, indexedAt: file.indexedAt, data: file.data.toString("base64") }); } finally { await attachments.close(); }
  const notes = Note.find({ owner }).select("+history +activity").sort({ _id: 1 }).cursor();
  try {
    for await (const note of notes) yield line("ownedNote", { ...toNoteResponse(note, owner), history: note.history, activity: note.activity });
  } finally { await notes.close(); }
  const ownedIds = await Note.find({ owner }).distinct("_id").exec();
  const discussions = Discussion.find({ $or: [{ noteId: { $in: ownedIds } }, { "posts.authorId": owner }] }).select("+posts -__v").cursor();
  const ownedSet = new Set(ownedIds.map(String));
  try { for await (const thread of discussions) yield line("discussion", { id: thread.id, noteId: thread.noteId, resolved: thread.resolved, posts: thread.posts.filter(post => ownedSet.has(String(thread.noteId)) || post.authorId === owner) }); } finally { await discussions.close(); }
  // Export only this account's current membership, not somebody else's content.
  const memberships = Note.find({ owner: { $ne: owner }, status: "active", "sharedWith.userId": owner }).select("title sharedWith").cursor();
  try {
    for await (const note of memberships) yield line("sharedMembership", { noteId: note.id, title: note.title, permission: note.sharedWith.find(member => String(member.userId) === owner)?.permission });
  } finally { await memberships.close(); }
  for (const [kind, makeCursor] of [
    ["dailyNote", () => Daily.find({ owner }).select("-__v").cursor()],
    ["schedule", () => Schedule.find({ owner }).select("-__v").cursor()],
    ["recoveryAction", () => AuthAction.find({ userId: owner }).select("purpose createdAt expiresAt -_id").cursor()],
    ["authenticationDelivery", () => AuthMail.find({ emailKey: emailKey(profile.email) }).select("kind attempts createdAt expiresAt -_id").cursor()],
    ["device", () => Device.find({ userId: owner }).select("-__v").cursor()],
  ] as const) {
    const cursor = makeCursor();
    try { for await (const record of cursor) yield line(kind, record); }
    finally { await cursor.close(); }
  }
  yield JSON.stringify({ kind: "complete", records: count, completedAt: new Date().toISOString() }) + "\n";
}
