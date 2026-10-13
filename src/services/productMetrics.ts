import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import User from "../models/user.model.js";
import MetricDay from "../models/metricDay.model.js";

export const METRIC_EVENTS = ["workspace_opened", "note_created", "note_opened", "note_saved", "markdown_imported", "archive_downloaded", "share_updated", "collaboration_token_issued", "companion_configured"] as const;
export type MetricEvent = typeof METRIC_EVENTS[number];
export async function getMetricsConsent(owner: string) {
  const user = await User.findById(owner).select("+metricsEnabled +metricsRevision").exec();
  if (!user) throw createHttpError(401, "Account is unavailable");
  return { enabled: user.metricsEnabled === true, revision: user.metricsRevision ?? 0 };
}
export async function setMetricsConsent(owner: string, enabled: unknown, revision: unknown) {
  if (typeof enabled !== "boolean") throw createHttpError(400, "Choose whether to allow usage counts");
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw createHttpError(428, "Load your current privacy setting first");
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    const user = await User.findById(owner).select("+metricsEnabled +metricsRevision +metricsSubject").session(session).exec();
    if (!user) throw createHttpError(401, "Account is unavailable");
    if ((user.metricsRevision ?? 0) !== revision) throw createHttpError(409, "Your privacy setting changed. Refresh before changing it");
    if (!enabled && user.metricsSubject) await MetricDay.deleteMany({ subject: user.metricsSubject }, { session }).exec();
    user.metricsEnabled = enabled; user.metricsRevision = Number(revision) + 1; user.metricsSubject = enabled ? user.metricsSubject || randomUUID() : ""; await user.save({ session });
  }); return { enabled, revision: Number(revision) + 1 }; } finally { await session.endSession(); }
}
/** No content, note IDs, request paths, names, addresses or calculator events are admitted. */
export async function recordMetric(owner: string, event: MetricEvent, now = new Date()) {
  if (!METRIC_EVENTS.includes(event)) throw createHttpError(400, "Unknown usage event");
  const current = await User.findOne({ _id: owner, metricsEnabled: true, suspendedAt: null }).select("+metricsSubject").lean().exec();
  if (!current?.metricsSubject) return;
  const subject = current.metricsSubject, day = now.toISOString().slice(0, 10), session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    // This write serializes consent withdrawal with pending event writes.
    const consent = await User.updateOne({ _id: owner, metricsEnabled: true, metricsSubject: subject, suspendedAt: null }, { $inc: { metricsSequence: 1 } }, { session, timestamps: false }).exec();
    if (!consent.modifiedCount) return;
    const existing = await MetricDay.findOne({ subject, day }).session(session).exec();
    if (existing && existing.total >= 1000) return;
    await MetricDay.updateOne({ subject, day }, { $inc: { ["counters." + event]: 1, total: 1 }, $setOnInsert: { expiresAt: new Date(Date.parse(day + "T00:00:00Z") + 90 * 86400000) } }, { session, upsert: true }).exec();
  }); } finally { await session.endSession(); }
}
export async function aggregateMetrics(now = new Date()) {
  const rows = MetricDay.aggregate([{ $match: { expiresAt: { $gt: now } } }, { $sort: { day: 1 } }, { $group: { _id: "$subject", days: { $push: "$day" }, events: { $push: { $objectToArray: "$counters" } } } }]).cursor();
  const events: Record<string, number> = Object.fromEntries(METRIC_EVENTS.map(event => [event, 0]));
  const cohorts = Object.fromEntries([1, 7, 28].map(day => [day, { eligible: 0, returned: 0 }]));
  let participants = 0, activeDays = 0;
  for await (const row of rows) {
    participants++; activeDays += row.days.length;
    for (const entries of row.events) for (const entry of entries) if (METRIC_EVENTS.includes(entry.k)) events[entry.k] += entry.v;
    const first = Date.parse(row.days[0] + "T00:00:00Z"), days = new Set(row.days);
    for (const offset of [1, 7, 28]) { const target = first + offset * 86400000; if (now.getTime() >= target + 86400000) { cohorts[offset].eligible++; if (days.has(new Date(target).toISOString().slice(0, 10))) cohorts[offset].returned++; } }
  }
  return { windowDays: 90, participants, activeDays, events, cohorts, basis: "Consenting accounts; UTC days since first retained observed activity. Successful API requests, not unique notes or verified activation. Calculator activity is excluded." };
}
