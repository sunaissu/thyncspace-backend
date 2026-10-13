import { createHash } from "node:crypto";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import Attachment from "../models/attachment.model.js";
import Quota from "../models/attachmentQuota.model.js";
import { ArchiveImport, ArchiveItem } from "../models/archiveImport.model.js";
import { ATTACHMENT_LIMITS, attachmentId, validateAttachment } from "./attachments.js";
import { validateNoteTitle, validateNoteType, validateNoteContentForType, validateNoteOrganization, validateSourcePath } from "../util/validation.js";
import { NoteType } from "../types/_enums.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";

import { validateLinkedSelection, type LinkedSelection } from "../util/linkedSelection.js";

export const ARCHIVE_LIMITS = { notes: 1000, files: 100, bytes: 175 * 1024 * 1024, fileBytes: 50 * 1024 * 1024 };
export const archiveHash = (value: string) => createHash("sha256").update(value).digest("hex");
const expiry = () => new Date(Date.now() + 6 * 60 * 60 * 1000);
export const archiveClientId = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw createHttpError(400, "Invalid archive request ID"); return value.toLowerCase(); };
export const archiveStatus = (job: { clientId: string; digest: string; expected: number; next: number; status: string; notes: number; files: number; reusedFiles: number; noteIds: string[]; expiresAt: Date }) => ({ clientId: job.clientId, digest: job.digest, expected: job.expected, next: job.next, status: job.status, notes: job.notes, files: job.files, reusedFiles: job.reusedFiles, noteIds: job.noteIds, expiresAt: job.expiresAt });

export async function* exportWorkspace(owner: string) {
  let count = 0, notes = 0, files = 0, bytes = 0, fileBytes = 0;
  const digest = createHash("sha256"), ids: string[] = [], activeIds: string[] = [];
  yield JSON.stringify({ kind: "manifest", format: "thyncspace-workspace", version: 1, createdAt: new Date().toISOString() }) + "\n";
  const record = (value: unknown) => { const text = JSON.stringify(value); bytes += Buffer.byteLength(text); if (bytes > ARCHIVE_LIMITS.bytes) throw createHttpError(413, "Workspace exceeds the 175 MiB archive limit"); count++; digest.update(archiveHash(text) + "\n"); return text + "\n"; };
  const cursor = Note.find({ owner }).sort({ _id: 1 }).cursor();
  try { for await (const note of cursor) {
    if (++notes > ARCHIVE_LIMITS.notes) throw createHttpError(413, "Workspace exceeds the 1,000-note archive limit");
    ids.push(note.id); if (note.status === "active") activeIds.push(note.id);
    yield record({ kind: "note", id: note.id, data: { title: note.title, type: note.type, content: Buffer.from(note.content ?? "", "utf8").toString("base64"), contentEncoding: "base64", status: note.status, notebook: note.notebook, tags: note.tags, sourcePath: note.sourcePath, isTemplate: note.isTemplate, isArchived: note.isArchived, linkedSources: note.linkedSources.map(link => ({ noteId: link.noteId, sourceRevision: link.sourceRevision, selection: validateLinkedSelection(link.selection) })) } });
  } } finally { await cursor.close(); }
  const idSet = new Set(ids);
  const attachments = Attachment.find({ $or: [{ owner }, { references: { $in: activeIds } }] }).select("+data +ocrText").sort({ _id: 1 }).cursor();
  try { for await (const file of attachments) {
    // A non-owned file must still have an accessible host when its bytes are read.
    if (String(file.owner) !== owner && !await Note.exists({ _id: { $in: file.references }, owner, status: "active" })) continue;
    if (++files > ARCHIVE_LIMITS.files || (fileBytes += file.bytes) > ARCHIVE_LIMITS.fileBytes) throw createHttpError(413, "Workspace attachments exceed archive limits");
    yield record({ kind: "attachment", id: file.id, data: { name: file.name, mime: file.mime, data: file.data.toString("base64"), references: file.references.filter(id => idSet.has(id)), ocrText: file.ocrText ?? "" } });
  } } finally { await attachments.close(); }
  yield JSON.stringify({ kind: "complete", records: count, notes, files, digest: digest.digest("hex") }) + "\n";
}

export async function startArchive(owner: string, input: { clientId?: unknown; digest?: unknown; records?: unknown }) {
  const clientId = archiveClientId(input.clientId);
  if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest) || !Number.isSafeInteger(input.records) || Number(input.records) < 0 || Number(input.records) > 1100) throw createHttpError(400, "Invalid archive completion record");
  const current = await ArchiveImport.findById(owner).exec();
  if (current && current.expiresAt > new Date()) {
    if (current.clientId !== clientId || current.digest !== input.digest || current.expected !== input.records) throw createHttpError(409, "Finish or dismiss the existing archive import first");
    return archiveStatus(current);
  }
  // _id is the owner, so concurrent starts cannot admit two imports.
  await ArchiveImport.deleteOne({ _id: owner, expiresAt: { $lte: new Date() } }).exec();
  await ArchiveItem.deleteMany({ owner, expiresAt: { $lte: new Date() } }).exec();
  try { return archiveStatus(await ArchiveImport.create({ _id: owner, clientId, digest: input.digest, expected: input.records, expiresAt: expiry() })); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === 11000) throw createHttpError(409, "An archive import already started. Refresh its status"); throw error; }
}

interface ArchivedNote { title: string; type: NoteType; content: string; status: "active" | "trashed"; notebook: string; tags: string[]; sourcePath?: string; isTemplate?: boolean; isArchived?: boolean; linkedSources: Array<{ noteId: string; sourceRevision: number; selection: LinkedSelection | null }> }
interface ArchivedFile { name: string; mime: string; data: string; bytes: number; hash: string; references: string[]; ocrText: string }
export async function validateArchiveRecord(value: unknown, owner?: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw createHttpError(400, "Invalid archive record");
  const record = value as { kind?: unknown; id?: unknown; data?: unknown };
  const sourceId = attachmentId(record.id), kind = record.kind;
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw createHttpError(400, "Invalid archive data");
  const data = record.data as Record<string, unknown>;
  if (kind === "note") {
    if (data.contentEncoding !== "base64" || typeof data.content !== "string" || data.content.length > 1398104 || data.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.content)) throw createHttpError(400, "Invalid archived text encoding");
    const decoded = Buffer.from(data.content, "base64");
    if (decoded.toString("base64") !== data.content) throw createHttpError(400, "Invalid archived text encoding");
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(decoded); } catch { throw createHttpError(400, "Archived text must use UTF-8"); }
    const type = validateNoteType(data.type), content = validateNoteContentForType(text, type);
    if (typeof content !== "string" || !["active", "trashed"].includes(String(data.status)) || !Array.isArray(data.linkedSources) || data.linkedSources.length > 20) throw createHttpError(400, "Invalid archived note");
    const linkedSources = data.linkedSources.map((item: unknown) => {
      if (!item || typeof item !== "object") throw createHttpError(400, "Invalid source link");
      const link = item as { noteId: unknown; sourceRevision: unknown; selection?: unknown };
      if (!Number.isSafeInteger(link.sourceRevision) || Number(link.sourceRevision) < 0) throw createHttpError(400, "Invalid source revision");
      return { noteId: attachmentId(link.noteId), sourceRevision: Number(link.sourceRevision), selection: validateLinkedSelection(link.selection) };
    });
    const payload: ArchivedNote = { title: validateNoteTitle(data.title), type, content, status: data.status as "active" | "trashed", ...validateNoteOrganization(data), sourcePath: validateSourcePath(data.sourcePath), linkedSources };
    return { kind, sourceId, payload: JSON.stringify(payload), fileBytes: 0, title: payload.title, sourcePath: payload.sourcePath };
  }
  if (kind === "attachment") {
    if (!Array.isArray(data.references) || data.references.length > 100 || typeof data.ocrText !== "string" || data.ocrText.length > 50000 || data.ocrText.includes("\0")) throw createHttpError(400, "Invalid attachment references or search text");
    const file = await validateAttachment(data);
    // Reuse bytes already admitted for this owner. Re-encoding a JPEG again
    // would otherwise change its hash and consume another storage slot.
    const original = Buffer.from(data.data as string, "base64");
    const byteHash = createHash("sha256").update(original).digest("hex");
    if (owner && await Attachment.exists({ owner, hash: byteHash, mime: file.mime })) { file.data = original; file.bytes = original.length; file.hash = byteHash; }
    if (data.ocrText && !file.mime.startsWith("image/")) throw createHttpError(400, "Only images can contain reviewed OCR text");
    const payload: ArchivedFile = { ...file, data: file.data.toString("base64"), references: [...new Set(data.references.map(attachmentId))], ocrText: data.ocrText };
    return { kind, sourceId, payload: JSON.stringify(payload), fileBytes: file.bytes };
  }
  throw createHttpError(400, "Unsupported archive record type");
}

export async function stageArchive(owner: string, id: unknown, index: unknown, record: unknown) {
  const clientId = archiveClientId(id);
  if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= 1100) throw createHttpError(400, "Invalid archive record index");
  const original = JSON.stringify(record); if (!original) throw createHttpError(400, "Missing archive record");
  const bytes = Buffer.byteLength(original), hash = archiveHash(original);
  const current = await ArchiveImport.findOne({ _id: owner, clientId, status: "loading", expiresAt: { $gt: new Date() } }).exec();
  if (!current) throw createHttpError(409, "Archive import expired or completed");
  const existing = await ArchiveItem.findOne({ owner, clientId, index }).exec();
  if (existing) { if (existing.hash !== hash) throw createHttpError(409, "This archive record changed since upload"); return archiveStatus(current); }
  const value = await validateArchiveRecord(record, owner), session = await mongoose.startSession();
  let result: ReturnType<typeof archiveStatus> | undefined;
  try { await session.withTransaction(async () => {
    const job = await ArchiveImport.findOne({ _id: owner, clientId, status: "loading", expiresAt: { $gt: new Date() } }).session(session).exec();
    if (!job || job.next !== index || job.next >= job.expected) throw createHttpError(409, "Reload archive progress before continuing");
    if (job.bytes + bytes > ARCHIVE_LIMITS.bytes || job.notes + (value.kind === "note" ? 1 : 0) > ARCHIVE_LIMITS.notes || job.files + (value.kind === "attachment" ? 1 : 0) > ARCHIVE_LIMITS.files || job.fileBytes + value.fileBytes > ARCHIVE_LIMITS.fileBytes) throw createHttpError(413, "The archive exceeds workspace import limits");
    await ArchiveItem.create([{ owner, clientId, index, sourceId: value.sourceId, kind: value.kind, hash, payload: value.payload, title: value.kind === "note" ? value.title : undefined, sourcePath: value.kind === "note" ? value.sourcePath : undefined, expiresAt: job.expiresAt }], { session });
    job.next++; job.bytes += bytes; job.fileBytes += value.fileBytes; if (value.kind === "note") job.notes++; else job.files++; await job.save({ session }); result = archiveStatus(job);
  }); } finally { await session.endSession(); }
  return result!;
}

export function remapArchiveLinks(content: string, ids: Map<string, string>, resolveName?: (name: string) => string | undefined) {
  let fence = "", width = 0;
  return content.split("\n").map(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { if (!fence) { fence = marker[1][0]; width = marker[1].length; } else if (marker[1][0] === fence && marker[1].length >= width && !line.slice(marker[0].length).trim()) fence = ""; return line; }
    if (fence) return line;
    return line.replace(/(`+)[\s\S]*?\1|(?<!\\)\[\[([^\]\n]{1,500})\]\]/g, (match, code, target: string) => {
      if (code) return match;
      const [address, ...label] = target.split("|"), anchorAt = address.indexOf("#"), name = (anchorAt < 0 ? address : address.slice(0, anchorAt)).trim(), anchor = anchorAt < 0 ? "" : address.slice(anchorAt);
      const id = ids.get(name.toLowerCase()) ?? resolveName?.(name); if (!id) return match;
      return "[[" + id + anchor + (label.length ? "|" + label.join("|") : ids.has(name.toLowerCase()) ? "" : "|" + address) + "]]";
    });
  }).join("\n");
}

export async function commitArchive(owner: string, id: unknown) {
  const clientId = archiveClientId(id), session = await mongoose.startSession();
  let result: ReturnType<typeof archiveStatus> | undefined;
  try { await session.withTransaction(async () => {
    const job = await ArchiveImport.findOne({ _id: owner, clientId, expiresAt: { $gt: new Date() } }).session(session).exec();
    if (!job) throw createHttpError(409, "Archive import expired");
    if (job.status === "complete") { result = archiveStatus(job); return; }
    if (job.next !== job.expected) throw createHttpError(409, "Upload every archive record before restoring");
    const headers = await ArchiveItem.find({ owner, clientId }).sort({ index: 1 }).session(session).exec();
    if (headers.length !== job.expected || archiveHash(headers.map(item => item.hash + "\n").join("")) !== job.digest) throw createHttpError(400, "Archive completion checksum does not match");
    const ids = new Map(headers.filter(item => item.kind === "note").map(item => [item.sourceId, new mongoose.Types.ObjectId().toString()]));
    const normalize = (path: string) => { const parts: string[] = []; for (const part of path.split("\\").join("/").split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!parts.length) return ""; parts.pop(); } else parts.push(part); } return parts.join("/").replace(/\.md$/i, "").toLowerCase(); };
    const names = new Map<string, string[]>();
    for (const item of headers.filter(item => item.kind === "note")) for (const name of new Set([normalize(item.title ?? ""), normalize(item.sourcePath ?? "")].filter(Boolean))) names.set(name, [...(names.get(name) ?? []), ids.get(item.sourceId)!]);
    const resolve = (name: string, path: string | undefined, self: string) => { if (!name) return self; const relative = path ? names.get(normalize(path.split("/").slice(0, -1).concat(name).join("/"))) : undefined; const matches = relative?.length ? relative : names.get(normalize(name)); return matches?.length === 1 ? matches[0] : undefined; };
    const cursor = ArchiveItem.find({ owner, clientId }).sort({ index: 1 }).select("+payload").session(session).cursor();
    let addedBytes = 0, addedFiles = 0, reusedFiles = 0;
    try { for await (const item of cursor) {
      if (item.kind === "note") {
        const value = JSON.parse(item.payload) as ArchivedNote;
        await Note.create([{ ...value, _id: ids.get(item.sourceId), owner, sharedWith: [], sharedNotebookId: null, favoritedBy: [], contentRevision: 0,
          content: validateNoteContentForType(value.type === NoteType.Document ? remapArchiveLinks(value.content, ids, name => resolve(name, value.sourcePath, ids.get(item.sourceId)!)) : value.content, value.type),
          linkedSources: value.linkedSources.filter(link => link.noteId !== item.sourceId).map(link => ({ noteId: ids.get(link.noteId) ?? link.noteId, sourceRevision: ids.has(link.noteId) ? 0 : link.sourceRevision, selection: link.selection && ids.has(link.noteId) ? { ...link.selection, needsReview: true } : link.selection })),
          ...(value.status === "trashed" ? { trashedAt: new Date() } : {}),
        }], { session });
      } else {
        const value = JSON.parse(item.payload) as ArchivedFile;
        if (value.references.some(id => !ids.has(id))) throw createHttpError(400, "An attachment references a note missing from the archive");
        const references = value.references.map(id => ids.get(id)!);
        const duplicate = await Attachment.findOne({ owner, hash: value.hash }).session(session).exec();
        if (duplicate) {
          const combined = [...new Set([...duplicate.references, ...references])];
          if (combined.length > ATTACHMENT_LIMITS.references) throw createHttpError(409, "An existing attachment would exceed 100 note references");
          duplicate.references = combined; await duplicate.save({ session }); reusedFiles++;
          // Existing owned file metadata, including reviewed OCR, stays unchanged.
        } else {
          await Attachment.create([{ ...value, owner, references, data: Buffer.from(value.data, "base64"), ...(value.ocrText ? { indexedAt: new Date(), ocrRevision: 1 } : {}) }], { session }); addedFiles++; addedBytes += value.bytes;
        }
      }
    } } finally { await cursor.close(); }
    await Quota.updateOne({ owner }, { $setOnInsert: { bytes: 0, count: 0 } }, { upsert: true, session }).exec();
    const quota = await Quota.updateOne({ owner, count: { $lte: ATTACHMENT_LIMITS.count - addedFiles }, bytes: { $lte: ATTACHMENT_LIMITS.accountBytes - addedBytes } }, { $inc: { count: addedFiles, bytes: addedBytes } }, { session }).exec();
    if (!quota.matchedCount) throw createHttpError(409, "The restored files would exceed your attachment storage limit");
    job.status = "complete"; job.noteIds = [...ids.values()]; job.reusedFiles = reusedFiles; job.expiresAt = new Date(Date.now() + 30 * 86400000); await job.save({ session }); result = archiveStatus(job);
    await ArchiveItem.deleteMany({ owner, clientId }, { session }).exec();
  }); } finally { await session.endSession(); }
  await invalidateOwnedNotesCache(owner);
  return result!;
}

export async function cancelArchive(owner: string, id: unknown) {
  const clientId = archiveClientId(id), session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    const removed = await ArchiveImport.deleteOne({ _id: owner, clientId }, { session }).exec();
    if (!removed.deletedCount) throw createHttpError(409, "The archive import changed. Refresh before dismissing it");
    await ArchiveItem.deleteMany({ owner, clientId }, { session }).exec();
  }); } finally { await session.endSession(); }
}
