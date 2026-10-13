import { createHash } from "node:crypto";
import createHttpError from "http-errors";
import mongoose from "mongoose";
import sharp from "sharp";
import Attachment from "../models/attachment.model.js";
import Quota from "../models/attachmentQuota.model.js";
import Note from "../models/note.model.js";

export const ATTACHMENT_LIMITS = { fileBytes: 2 * 1024 * 1024, accountBytes: 50 * 1024 * 1024, count: 100, references: 100, pixels: 12_000_000 };
export const attachmentId = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) throw createHttpError(400, "Invalid attachment or note ID"); return value.toLowerCase(); };
export const noteAccessFilter = (userId: string, edit = false) => ({ status: "active", $or: [{ owner: userId }, { sharedWith: { $elemMatch: { userId, ...(edit ? { permission: "editor" } : {}) } } }] });
let imageDecodes = 0;
export async function validateAttachment(input: unknown) {
  if (!input || typeof input !== "object") throw createHttpError(400, "Choose a file");
  const value = input as { name?: unknown; mime?: unknown; data?: unknown };
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\p{Cc}/\\]/u.test(value.name)) throw createHttpError(400, "File names must be 1–200 characters without paths or controls");
  if (typeof value.data !== "string" || value.data.length > Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw createHttpError(400, "Use a file no larger than 2 MiB");
  let data = Buffer.from(value.data, "base64");
  if (data.length > ATTACHMENT_LIMITS.fileBytes) throw createHttpError(400, "Use a file no larger than 2 MiB");
  if (!data.length || data.toString("base64") !== value.data) throw createHttpError(400, "Invalid file data");
  const mime = value.mime;
  if (mime === "text/plain") {
    try { if (new TextDecoder("utf-8", { fatal: true }).decode(data).includes("\0")) throw new Error(); }
    catch { throw createHttpError(400, "Text attachments must contain UTF-8 text without null characters"); }
  } else if (mime === "application/pdf") {
    if (!/^%PDF-1\.[0-7]|^%PDF-2\.0/.test(data.subarray(0, 8).toString("ascii")) || !data.subarray(Math.max(0, data.length - 1024)).includes(Buffer.from("%%EOF"))) throw createHttpError(400, "Invalid PDF file");
  } else if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp") {
    // Gate formats before decoding: SVG, remote paths and arbitrary containers
    // must never reach a decoder that also supports vector or document inputs.
    const format = mime.split("/")[1];
    const signature = format === "png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : format === "jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255 : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
    if (!signature) throw createHttpError(400, "The image does not match its declared format");
    if (imageDecodes >= 2) throw createHttpError(429, "Image processing is busy. Retry shortly.");
    imageDecodes++;
    try {
      const image = sharp(data, { limitInputPixels: ATTACHMENT_LIMITS.pixels, failOn: "warning" });
      const metadata = await image.metadata();
      if (metadata.format !== format || (metadata.pages ?? 1) > 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > ATTACHMENT_LIMITS.pixels) throw new Error();
      // Decode and re-encode, respecting orientation and removing metadata.
      data = await image.rotate().toBuffer();
    } catch { throw createHttpError(400, "Use a valid, static PNG, JPEG or WebP image with at most 12 million pixels"); }
    finally { imageDecodes--; }
    if (data.length > ATTACHMENT_LIMITS.fileBytes) throw createHttpError(400, "The normalized image exceeds 2 MiB. Reduce its dimensions before uploading");
  } else throw createHttpError(400, "Supported files: static PNG/JPEG/WebP, PDF, and UTF-8 text");
  return { name: value.name.trim(), mime, data, bytes: data.length, hash: createHash("sha256").update(data).digest("hex") };
}

export async function storeAttachment(owner: string, input: unknown) {
  const value = await validateAttachment(input);
  try { await Quota.updateOne({ owner }, { $setOnInsert: { bytes: 0, count: 0 } }, { upsert: true }).exec(); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error; }
  const session = await mongoose.startSession();
  let id = "";
  try {
    await session.withTransaction(async () => {
      const duplicate = await Attachment.findOne({ owner, hash: value.hash }).session(session).exec();
      if (duplicate) { id = duplicate.id; return; }
      const quota = await Quota.updateOne({ owner, count: { $lt: ATTACHMENT_LIMITS.count }, bytes: { $lte: ATTACHMENT_LIMITS.accountBytes - value.bytes } }, { $inc: { bytes: value.bytes, count: 1 } }, { session }).exec();
      if (!quota.modifiedCount) throw createHttpError(409, "Attachment storage is full (100 files or 50 MiB). Remove unused files first");
      const [file] = await Attachment.create([{ owner, ...value }], { session }); id = file.id;
    });
  } finally { await session.endSession(); }
  return Attachment.findById(id).exec();
}

export async function accessibleAttachment(id: string, userId: string, includeData = false) {
  const file = await Attachment.findById(attachmentId(id)).select(includeData ? "+data" : "").exec();
  if (!file) throw createHttpError(404, "Attachment not found");
  if (String(file.owner) !== userId && !await Note.exists({ _id: { $in: file.references }, ...noteAccessFilter(userId) })) throw createHttpError(404, "Attachment not found");
  return file;
}

export async function copyAttachmentReferences(from: string, to: string, consume: boolean, session: mongoose.ClientSession) {
  if (!consume && await Attachment.exists({ references: from, $expr: { $gte: [{ $size: "$references" }, ATTACHMENT_LIMITS.references] } }).session(session)) throw createHttpError(409, "An attachment reached its note-reference limit. Remove an old reference before restoring another copy");
  await Attachment.updateMany({ references: from }, [{ $set: { references: { $setUnion: [consume ? { $setDifference: ["$references", [from]] } : "$references", [to]] } } }], { session }).exec();
}
