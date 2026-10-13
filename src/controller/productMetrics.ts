import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import { getMetricsConsent, setMetricsConsent, recordMetric, type MetricEvent } from "../services/productMetrics.js";
import { summarizeError } from "../util/errorLogging.js";

export const metricsConsent: RequestHandler = async (req, res, next) => {
  try { if (!req.user) throw createHttpError(401, "Authentication required"); res.json(req.method === "GET" ? await getMetricsConsent(req.user.id) : await setMetricsConsent(req.user.id, req.body?.enabled, req.body?.expectedRevision)); } catch (error) { next(error); }
};
const routes: Record<string, MetricEvent> = { "GET /": "workspace_opened", "POST /": "note_created", "GET /:noteId": "note_opened", "PATCH /:noteId/private": "note_saved", "POST /import": "markdown_imported", "GET /archive/export": "archive_downloaded", "PUT /:noteId/collaborators": "share_updated", "POST /:noteId/collaboration-token": "collaboration_token_issued", "POST /companion-connections": "companion_configured" };
let pending = 0;
export const observeNoteMetrics: RequestHandler = (req, res, next) => {
  res.once("finish", () => {
    const event = Object.prototype.hasOwnProperty.call(routes, req.method + " " + req.route?.path) ? routes[req.method + " " + req.route.path] : undefined;
    if (!event || !req.user || res.statusCode < 200 || res.statusCode >= 300 || pending >= 32) return;
    pending++; void recordMetric(req.user.id, event).catch(error => console.error("Usage count failed", summarizeError(error))).finally(() => { pending--; });
  }); next();
};
