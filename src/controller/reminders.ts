import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import Reminders from "../models/reminders.model.js";
import Note from "../models/note.model.js";
import { attachmentId, noteAccessFilter } from "../services/attachments.js";
import { withNoteMutationLock } from "../util/noteMutationLock.js";

const date = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw createHttpError(400, "Choose a valid reminder date and time");
  const parsed = new Date(value);
  if (parsed.getTime() < Date.now() - 366 * 86400000 || parsed.getTime() > Date.now() + 10 * 366 * 86400000) throw createHttpError(400, "Reminder dates must be within the past year and next ten years");
  return parsed;
};
const taskPattern = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/;
const taskLine = (content: string, index: number) => {
  const lines = content.split(/\r?\n/); let fence = "";
  for (let line = 0; line <= index && line < lines.length; line++) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[line]);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !lines[line].slice(marker[0].length).trim()) fence = ""; continue; }
    if (line === index && !fence && taskPattern.test(lines[line])) return lines[line];
  }
  return undefined;
};
async function response(owner: string, value: InstanceType<typeof Reminders> | null) {
  const notes = await Note.find({ _id: { $in: value?.entries.map(entry => entry.noteId) ?? [] }, ...noteAccessFilter(owner) }).select("title type content").exec();
  const byId = new Map(notes.map(note => [note.id, note]));
  return { revision: value?.revision ?? 0, entries: (value?.entries ?? []).map(entry => {
    const note = byId.get(entry.noteId), current = note?.type === "document" && entry.taskLine !== undefined ? taskLine(note.content ?? "", entry.taskLine - 1) : undefined;
    const normalize = (text: string) => text.replace(/\[[ xX]\]/, "[ ]");
    const changed = entry.taskLine !== undefined && (current === undefined || normalize(current) !== normalize(entry.sourceText ?? ""));
    return { id: entry.id, noteId: entry.noteId, title: note?.title ?? "Unavailable note", available: Boolean(note), dueAt: entry.dueAt, repeatDays: entry.repeatDays, completedAt: entry.completedAt, taskLine: entry.taskLine, taskText: note ? entry.sourceText : undefined, sourceChanged: Boolean(note && changed), taskDone: Boolean(!changed && current && taskPattern.exec(current)?.[1].toLowerCase() === "x") };
  }) };
}
export const listReminders: RequestHandler = async (req, res, next) => {
  try { if (!req.user) throw createHttpError(401, "Authentication required"); res.json(await response(req.user.id, await Reminders.findOne({ owner: req.user.id }).exec())); }
  catch (error) { next(error); }
};
export const updateReminders: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const owner = req.user.id;
    await withNoteMutationLock(`reminders:${owner}`, async () => {
      const value = await Reminders.findOne({ owner }).exec() ?? new Reminders({ owner });
      const input = req.body, action = input?.action;
      if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) throw createHttpError(428, "Load current reminders before changing them");
      if (value.revision !== input.expectedRevision) throw createHttpError(409, "Reminders changed in another tab. Refresh before saving");
      if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/i.test(input.id)) throw createHttpError(400, "Invalid reminder ID");
      const entry = value.entries.find(entry => entry.id === input.id);
      if (action === "create") {
        if (entry) throw createHttpError(409, "This reminder already exists. Refresh the list");
        if (value.entries.length >= 100) throw createHttpError(409, "Remove a reminder before adding another (100 maximum)");
        const noteId = attachmentId(input.noteId), note = await Note.findOne({ _id: noteId, ...noteAccessFilter(owner) }).exec();
        if (!note) throw createHttpError(404, "Note not found");
        if (!Number.isInteger(input.repeatDays) || input.repeatDays < 0 || input.repeatDays > 365) throw createHttpError(400, "Review intervals must be 0–365 days");
        let sourceText: string | undefined;
        if (input.taskLine !== undefined) {
          if (!Number.isSafeInteger(input.taskLine) || input.taskLine < 1 || input.taskLine > 100000 || note.type !== "document") throw createHttpError(400, "Select a document task");
          sourceText = taskLine(note.content ?? "", input.taskLine - 1);
          if (!sourceText || sourceText.length > 2000 || sourceText !== input.sourceText || taskPattern.exec(sourceText)?.[1].toLowerCase() === "x") throw createHttpError(409, "The selected task changed or is complete. Refresh the source note");
        }
        value.entries.push({ id: input.id, noteId, dueAt: date(input.dueAt), repeatDays: input.repeatDays, taskLine: input.taskLine, sourceText, createdAt: new Date() });
      } else {
        if (!entry) throw createHttpError(404, "Reminder not found");
        if (action === "delete") value.set("entries", value.entries.filter(item => item.id !== input.id));
        else if (action === "snooze") { entry.dueAt = date(input.dueAt); entry.completedAt = undefined; }
        else if (action === "complete") {
          if (entry.completedAt) throw createHttpError(409, "This reminder is already complete");
          if (entry.repeatDays) {
            const interval = entry.repeatDays * 86400000, next = entry.dueAt.getTime() + Math.max(1, Math.floor((Date.now() - entry.dueAt.getTime()) / interval) + 1) * interval;
            entry.dueAt = new Date(next);
          } else entry.completedAt = new Date();
        } else throw createHttpError(400, "Unknown reminder action");
      }
      value.revision++; await value.save(); res.json(await response(owner, value));
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "VersionError" || ("code" in error && error.code === 11000))) next(createHttpError(409, "Reminders changed. Refresh and try again"));
    else next(error);
  }
};
