import type { RequestHandler } from "express";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import Note from "../models/note.model.js";
import Schedule from "../models/noteSchedule.model.js";
import Daily from "../models/dailyNote.model.js";
import { nextOccurrence, templateContent, validateRecurrence } from "../services/noteSchedules.js";
import { toNoteResponse } from "../util/noteResponse.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";
import { withNoteMutationLock } from "../util/noteMutationLock.js";
const ownerId = (req: Parameters<RequestHandler>[0]) => { if (!req.user) throw createHttpError(401, "Authentication required"); return req.user.id; };
const scheduleId = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) throw createHttpError(400, "Invalid schedule ID"); return value; };
const response = (value: InstanceType<typeof Schedule>) => ({ id: value.id, title: value.title, templateId: value.templateId, cadence: value.cadence, time: value.time, weekday: value.weekday, isActive: value.isActive, nextRunAt: value.nextRunAt, lastRunAt: value.lastRunAt, lastNoteId: value.lastNoteId, error: value.error });

export const dailyNote: RequestHandler = async (req, res, next) => {
  try {
    const owner = ownerId(req), date = req.body?.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw createHttpError(400, "Choose a valid date");
    const generationKey = `daily:${owner}:${date}`;
    const note = await withNoteMutationLock(generationKey, async () => {
      if (req.body.templateId !== undefined && typeof req.body.templateId !== "string") throw createHttpError(400, "Invalid template ID");
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = await mongoose.startSession();
        try {
          let result: InstanceType<typeof Note> | null = null;
          await session.withTransaction(async () => {
            const daily = await Daily.findOne({ owner, date }).session(session).exec();
            const existing = daily ? await Note.findOne({ _id: daily.noteId, owner }).session(session).exec() : null;
            if (existing) { result = existing; return; }
            const template = await templateContent(owner, req.body.templateId, session);
            const [created] = await Note.create([{ ...template, owner, title: `Daily ${date}` }], { session });
            await Daily.updateOne({ owner, date }, { $set: { noteId: created._id } }, { upsert: true, session }).exec();
            result = created;
          });
          if (!result) throw new Error("Daily note transaction did not complete");
          return result as InstanceType<typeof Note>;
        } catch (error) {
          if (attempt || !(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
        } finally { await session.endSession(); }
      }
      throw createHttpError(409, "Daily note changed; try again");
    });
    if (note.status !== "active") throw createHttpError(409, "That daily note is in trash. Restore it before creating another for this date.");
    await invalidateOwnedNotesCache(owner);
    res.json(toNoteResponse(note, owner));
  } catch (error) { next(error); }
};
export const listSchedules: RequestHandler = async (req, res, next) => {
  try { res.json((await Schedule.find({ owner: ownerId(req) }).sort({ nextRunAt: 1 }).exec()).map(response)); } catch (error) { next(error); }
};
export const createSchedule: RequestHandler = async (req, res, next) => {
  try {
    const owner = ownerId(req), rule = validateRecurrence(req.body ?? {});
    const templateId = scheduleId(req.body?.templateId);
    const title = req.body.title;
    if (typeof title !== "string" || !title.trim() || title.trim().length > 120 || /\p{Cc}/u.test(title)) throw createHttpError(400, "Use a schedule title of 1 to 120 characters");
    await templateContent(owner, templateId);
    const schedule = await withNoteMutationLock(`schedules:${owner}`, async () => {
      const existing = await Schedule.find({ owner }).select("slot").exec();
      const slot = Array.from({ length: 20 }, (_, index) => index).find(index => !existing.some(item => item.slot === index));
      if (slot === undefined) throw createHttpError(409, "Remove a schedule before adding another (maximum 20)");
      try { return await Schedule.create({ owner, slot, templateId, title: title.trim(), ...rule, nextRunAt: nextOccurrence(rule, new Date()) }); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === 11000) throw createHttpError(409, "Schedules changed in another session; refresh and try again");
        throw error;
      }
    });
    res.status(201).json(response(schedule));
  } catch (error) { next(error); }
};
export const changeSchedule: RequestHandler = async (req, res, next) => {
  try {
    const filter = { _id: scheduleId(req.params.scheduleId), owner: ownerId(req) };
    if (req.method === "DELETE") {
      if (!(await Schedule.deleteOne(filter).exec()).deletedCount) throw createHttpError(404, "Schedule not found");
      res.sendStatus(204); return;
    }
    if (typeof req.body?.isActive !== "boolean") throw createHttpError(400, "Active must be a boolean");
    const schedule = await Schedule.findOne(filter).exec();
    if (!schedule) throw createHttpError(404, "Schedule not found");
    if (req.body.isActive) await templateContent(schedule.owner.toString(), schedule.templateId.toString());
    const saved = await Schedule.findOneAndUpdate(filter, { $set: { isActive: req.body.isActive, error: "", ...(req.body.isActive ? { nextRunAt: nextOccurrence({ cadence: schedule.cadence, time: schedule.time, weekday: schedule.weekday }, new Date()) } : {}) } }, { new: true }).exec();
    if (!saved) throw createHttpError(404, "Schedule not found");
    res.json(response(saved));
  } catch (error) { next(error); }
};
