import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ArchiveImport } from "../models/archiveImport.model.js";
import { archiveStatus, exportWorkspace, startArchive, stageArchive, commitArchive, cancelArchive } from "../services/workspaceArchive.js";

export const downloadArchive: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="thyncspace-workspace.jsonl"');
    await pipeline(Readable.from(exportWorkspace(req.user.id)), res);
  } catch (error) { if (!res.headersSent && !res.destroyed) next(error); }
};
export const importArchive: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const owner = req.user.id, body = req.body ?? {};
    if (req.method === "GET") { const job = await ArchiveImport.findOne({ _id: owner, expiresAt: { $gt: new Date() } }).exec(); res.json(job ? archiveStatus(job) : null); }
    else if (body.action === "start") res.json(await startArchive(owner, body));
    else if (body.action === "stage") res.json(await stageArchive(owner, body.clientId, body.index, body.record));
    else if (body.action === "batch") {
      if (!Array.isArray(body.records) || !body.records.length || body.records.length > 20 || !Number.isSafeInteger(body.index)) throw createHttpError(400, "Upload at most 20 archive records per batch");
      let status; for (let index = 0; index < body.records.length; index++) status = await stageArchive(owner, body.clientId, body.index + index, body.records[index]);
      res.json(status);
    }
    else if (body.action === "commit" && body.confirmation === "RESTORE PRIVATE COPIES") res.json(await commitArchive(owner, body.clientId));
    else if (body.action === "cancel") { await cancelArchive(owner, body.clientId); res.json(null); }
    else throw createHttpError(400, "Choose an archive import action");
  } catch (error) { next(error); }
};
