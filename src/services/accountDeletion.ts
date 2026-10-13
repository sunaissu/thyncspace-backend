import CompanionGrant from "../models/companionGrant.model.js";
import { ArchiveImport, ArchiveItem } from "../models/archiveImport.model.js";
import SharedNotebook from "../models/sharedNotebook.model.js";
import Discussion from "../models/discussion.model.js";
import Reminders from "../models/reminders.model.js";
import Attachment from "../models/attachment.model.js";
import AttachmentQuota from "../models/attachmentQuota.model.js";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import AuthAction from "../models/authAction.model.js";
import AuthMail from "../models/authMail.model.js";
import { emailKey } from "./authMail.js";
import User from "../models/user.model.js";
import UserAuth from "../models/userAuth.model.js";
import Note from "../models/note.model.js";
import Workspace from "../models/workspace.model.js";
import Daily from "../models/dailyNote.model.js";
import Schedule from "../models/noteSchedule.model.js";
import Device from "../models/deviceSession.model.js";
import PrivacyRequest from "../models/privacyRequest.model.js";

/** Operator-only maintenance operation. Stop every API/worker instance first. */
export async function fulfillDeletionRequest(requestId: string, username: string) {
  if (!mongoose.isValidObjectId(requestId)) throw createHttpError(400, "Invalid request ID");
  const session = await mongoose.startSession();
  let affectedOwners: string[] = [], owner = "";
  try {
    await session.withTransaction(async () => {
      const request = await PrivacyRequest.findOne({ _id: requestId, status: "pending" }).session(session).exec();
      if (!request) throw createHttpError(409, "Request is missing or cancelled");
      owner = String(request.owner);
      const user = await User.findById(owner).select("+email").session(session).exec();
      if (!user || user.username !== username) throw createHttpError(409, "The account name does not match; review the request again");
      const ids = (await Note.find({ owner }).select("_id").session(session).lean().exec()).map(note => String(note._id));
      affectedOwners = (await Note.distinct("owner", { $or: [{ "sharedWith.userId": owner }, { favoritedBy: owner }] }).session(session).exec()).map(String);
      await Note.updateMany({ owner: { $ne: owner }, $or: [{ "sharedWith.userId": owner }, { favoritedBy: owner }] }, { $pull: { sharedWith: { userId: owner }, favoritedBy: owner } }, { session }).exec();
      await Note.updateMany({ "activity.actorId": owner }, { $unset: { "activity.$[event].actorId": "" } }, { session, timestamps: false, arrayFilters: [{ "event.actorId": owner }] }).exec();
      await Note.updateMany({ "activity.targetId": owner }, { $unset: { "activity.$[event].targetId": "" } }, { session, timestamps: false, arrayFilters: [{ "event.targetId": owner }] }).exec();
      await Attachment.deleteMany({ owner }, { session }).exec();
      await AttachmentQuota.deleteOne({ owner }, { session }).exec();
      await Attachment.updateMany({ references: { $in: ids } }, { $pull: { references: { $in: ids } } }, { session }).exec();
      await Discussion.deleteMany({ noteId: { $in: ids } }, { session }).exec();
      await Discussion.updateMany({ "posts.0.authorId": owner }, { $set: { fingerprint: "" } }, { session }).exec();
      await Discussion.updateMany({ "posts.authorId": owner }, { $set: { "posts.$[post].authorId": "", "posts.$[post].body": "", "posts.$[post].mentions": [], "posts.$[post].deleted": true }, $inc: { revision: 1 } }, { session, arrayFilters: [{ "post.authorId": owner }] }).exec();
      await Discussion.updateMany({ "posts.mentions": owner }, { $pull: { "posts.$[].mentions": owner }, $inc: { revision: 1 } }, { session }).exec();
      await SharedNotebook.deleteMany({ owner }, { session }).exec();
      await SharedNotebook.updateMany({ "members.userId": owner }, { $pull: { members: { userId: owner } }, $inc: { revision: 1 } }, { session }).exec();
      await Note.deleteMany({ owner }, { session }).exec();
      await CompanionGrant.deleteMany({ owner }, { session }).exec();
      await ArchiveItem.deleteMany({ owner }, { session }).exec();
      await ArchiveImport.deleteOne({ _id: owner }, { session }).exec();
      await Workspace.updateMany({ owner: { $ne: owner }, $or: [{ pinned: { $in: ids } }, { "recent.noteId": { $in: ids } }] }, { $pull: { pinned: { $in: ids }, recent: { noteId: { $in: ids } } }, $inc: { revision: 1 } }, { session }).exec();
      await Reminders.deleteOne({ owner }, { session }).exec();
      await Workspace.deleteOne({ owner }, { session }).exec();
      await Daily.deleteMany({ owner }, { session }).exec();
      await Schedule.deleteMany({ owner }, { session }).exec();
      // Keep only revocation tombstones until cookie expiry. Otherwise a cached
      // session identity could register itself again after a Redis outage.
      await Device.updateMany({ userId: owner }, { $set: { revokedAt: new Date(), userAgent: "Deleted account" } }, { session }).exec();
      await AuthAction.deleteMany({ userId: owner }, { session }).exec();
      await AuthMail.deleteMany({ emailKey: emailKey(user.email) }, { session }).exec();
      await UserAuth.deleteOne({ userId: owner }, { session }).exec();
      await User.deleteOne({ _id: owner }, { session }).exec();
      await PrivacyRequest.deleteOne({ _id: requestId, status: "pending" }, { session }).exec();
    });
    return { owner, affectedOwners };
  } finally { await session.endSession(); }
}
