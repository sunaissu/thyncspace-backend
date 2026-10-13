import { hasWorkspaceAccess } from "../util/workspaceAccess.js";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import Schedule from "../models/noteSchedule.model.js";
import User from "../models/user.model.js";
import { NoteStatus, NoteType } from "../types/_enums.js";
import { validateNoteContentForType } from "../util/validation.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";
import { summarizeError } from "../util/errorLogging.js";

export interface Recurrence { cadence: "daily" | "weekly"; time: string; weekday: number }
export function validateRecurrence(value: Record<string, unknown>): Recurrence {
  if (!["daily", "weekly"].includes(value.cadence as string) || typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) || !Number.isInteger(value.weekday) || Number(value.weekday) < 0 || Number(value.weekday) > 6) throw createHttpError(400, "Choose a daily or weekly UTC time and a valid weekday");
  return { cadence: value.cadence as Recurrence["cadence"], time: value.time, weekday: Number(value.weekday) };
}
export function nextOccurrence(rule: Recurrence, after: Date) {
  const [hour, minute] = rule.time.split(":").map(Number);
  const next = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hour, minute));
  if (rule.cadence === "weekly") next.setUTCDate(next.getUTCDate() + (rule.weekday - next.getUTCDay() + 7) % 7);
  if (next <= after) next.setUTCDate(next.getUTCDate() + (rule.cadence === "weekly" ? 7 : 1));
  return next;
}
export async function templateContent(owner: string, templateId?: string, session?: mongoose.ClientSession) {
  if (!templateId) return { type: NoteType.Document, content: "", notebook: "Daily", tags: [] as string[] };
  if (!/^[a-f0-9]{24}$/i.test(templateId)) throw createHttpError(400, "Invalid template ID");
  const template = await Note.findOne({ _id: templateId, owner, isTemplate: true, status: NoteStatus.Active }).session(session ?? null).exec();
  if (!template) throw createHttpError(404, "The selected owned template is no longer available");
  return { type: template.type, content: validateNoteContentForType(template.content, template.type), notebook: template.notebook, tags: [...template.tags] };
}
export async function runDueSchedules(now = new Date()) {
  const due = await Schedule.find({ isActive: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 }).limit(25).select("_id").exec();
  for (const candidate of due) {
    const transaction = await mongoose.startSession();
    let owner: string | undefined;
    try {
      await transaction.withTransaction(async () => {
        const schedule = await Schedule.findOne({ _id: candidate._id, isActive: true, nextRunAt: { $lte: now } }).session(transaction).exec();
        if (!schedule) return;
        owner = schedule.owner.toString();
        const account = await User.findById(schedule.owner).select("emailVerifiedAt +suspendedAt").session(transaction).exec();
        if (!account) { await Schedule.deleteOne({ _id: schedule._id }).session(transaction); return; }
        if (!hasWorkspaceAccess(account)) { schedule.isActive = false; schedule.error = "Account verification or access requires review. Check Account security before resuming."; await schedule.save({ session: transaction }); return; }
        let template;
        try { template = await templateContent(owner, schedule.templateId.toString(), transaction); }
        catch (error) {
          if (createHttpError.isHttpError(error) && [400, 404].includes(error.status)) { schedule.isActive = false; schedule.error = "Template unavailable or invalid. Repair it before resuming, or create a new schedule."; await schedule.save({ session: transaction }); return; }
          throw error;
        }
        const generationKey = `schedule:${schedule.id}:${schedule.nextRunAt.toISOString()}`;
        let note = await Note.findOne({ generationKey }).session(transaction).exec();
        if (!note) [note] = await Note.create([{ ...template, owner: schedule.owner, title: `${schedule.title} ${schedule.nextRunAt.toISOString().slice(0, 10)}`, generationKey }], { session: transaction });
        schedule.lastRunAt = now; schedule.lastNoteId = note._id;
        schedule.nextRunAt = nextOccurrence({ cadence: schedule.cadence, time: schedule.time, weekday: schedule.weekday }, now);
        schedule.error = "";
        await schedule.save({ session: transaction });
      });
      if (owner) await invalidateOwnedNotesCache(owner);
    } finally { await transaction.endSession(); }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<void> | undefined;
export function startNoteScheduler() {
  const tick = () => {
    if (running) return;
    running = runDueSchedules().catch(error => console.error("Note scheduler failed", summarizeError(error))).finally(() => { running = undefined; });
  };
  if (timer) return;
  timer = setInterval(tick, 60000); timer.unref(); tick();
}
export async function stopNoteScheduler() { if (timer) clearInterval(timer); timer = undefined; await running; }
