import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import Workspace from "../models/workspace.model.js";
import Note from "../models/note.model.js";
import { withNoteMutationLock } from "../util/noteMutationLock.js";

const text = (value: unknown, max: number, optional = false) => {
  if (typeof value !== "string" || value.length > max || /\p{Cc}/u.test(value) || (!optional && !value.trim())) throw createHttpError(400, "Invalid workspace preference");
  return value.trim();
};
const noteId = (value: unknown) => { const id = text(value, 24); if (!/^[a-f0-9]{24}$/i.test(id)) throw createHttpError(400, "Invalid note ID"); return id.toLowerCase(); };
const date = (value: unknown) => {
  const result = text(value, 10, true);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) throw createHttpError(400, "Invalid search date");
  return result;
};
const response = (value: InstanceType<typeof Workspace> | null) => ({ revision: value?.revision ?? 0, pinned: value?.pinned ?? [], recent: value?.recent ?? [], searches: value?.searches ?? [] });

export const getWorkspace: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    res.json(response(await Workspace.findOne({ owner: req.user.id }).exec()));
  } catch (error) { next(error); }
};

export const updateWorkspace: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw createHttpError(401, "Authentication required");
    const owner = req.user.id;
    await withNoteMutationLock(`workspace:${owner}`, async () => {
      const workspace = await Workspace.findOne({ owner }).exec() ?? new Workspace({ owner });
      const action = req.body?.action;
      if (action === "pin" || action === "unpin" || action === "open") {
        const id = noteId(req.body.noteId);
        if (action !== "unpin" && !await Note.exists({ _id: id, status: "active", $or: [{ owner }, { "sharedWith.userId": owner }] })) throw createHttpError(404, "Note not found");
        if (action === "pin" && !workspace.pinned.includes(id)) {
          if (workspace.pinned.length >= 100) throw createHttpError(409, "Unpin a note before adding another");
          workspace.pinned.push(id);
        } else if (action === "unpin") workspace.pinned = workspace.pinned.filter(value => value !== id);
        else if (action === "open") workspace.set("recent", [{ noteId: id, openedAt: new Date() }, ...workspace.recent.filter(value => value.noteId !== id)].slice(0, 40));
      } else if (action === "clear-recent") workspace.set("recent", []);
      else if (action === "save-search") {
        const input = req.body.search;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw createHttpError(400, "Invalid search");
        const id = text(input.id, 36);
        if (!/^[a-z0-9-]+$/i.test(id)) throw createHttpError(400, "Invalid saved search ID");
        if (!["all", "shared", "documents", "boards", "documentation", "favorites", "pinned", "recent", "archived"].includes(input.view) || !["all", "mine", "shared"].includes(input.owner) || !["all", "document", "whiteboard", "documentation"].includes(input.type)) throw createHttpError(400, "Invalid search filters");
        const search = { id, name: text(input.name, 80), query: text(input.query, 300, true), notebook: text(input.notebook, 80, true), tag: text(input.tag, 40, true).toLowerCase(), owner: input.owner, type: input.type, view: input.view, from: date(input.from), to: date(input.to) };
        if (search.from && search.to && search.from > search.to) throw createHttpError(400, "Search start date must precede its end date");
        const previous = workspace.searches.filter(value => value.id !== id);
        if (previous.length >= 20) throw createHttpError(409, "Remove a saved search before adding another");
        workspace.set("searches", [...previous, search]);
      } else if (action === "delete-search") { const id = text(req.body.id, 36); workspace.set("searches", workspace.searches.filter(value => value.id !== id)); }
      else throw createHttpError(400, "Unknown workspace preference action");
      workspace.revision += 1;
      await workspace.save();
      res.json(response(workspace));
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "VersionError" || ("code" in error && error.code === 11000))) next(createHttpError(409, "Workspace preferences changed; reload and try again"));
    else next(error);
  }
};
