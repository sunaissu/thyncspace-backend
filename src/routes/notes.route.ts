import express from "express";
import rateLimit from "express-rate-limit";
import * as NoteController from "../controller/notes.js";
import { requireAuth } from "../util/auth.js";

import * as Library from "../controller/noteLibrary.js";
import * as Workspace from "../controller/workspace.js";

const router = express.Router();

const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  skip: (req) => ["GET", "HEAD", "OPTIONS"].includes(req.method),
  message: { error: "Too many note changes; please slow down." },
});

const creationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  message: { error: "Too many notes created; please try again later." },
});

const collaborationTokenLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  message: { error: "Too many collaboration requests; please reconnect later." },
});

router.use(requireAuth, mutationLimiter);

router.get("/", NoteController.getNotes);
router.get("/trash", Library.getTrash);
router.get("/storage", Library.getStorageUsage);
router.get("/workspace", Workspace.getWorkspace);
router.patch("/workspace", Workspace.updateWorkspace);
router.post("/organization/bulk", Library.bulkOrganization);
router.delete("/trash/:noteId", Library.permanentlyDeleteTrash);
router.get("/shared", NoteController.getSharedNotes);
router.get("/favorites", NoteController.getFavoriteNotes);
router.post("/", creationLimiter, NoteController.createNote);
router.post("/import", creationLimiter, NoteController.importNotes);
router.get("/:noteId/history", Library.getHistory);
router.get("/:noteId/history/:versionId", Library.getVersion);
router.patch("/:noteId/history/:versionId", Library.renameVersion);
router.post("/:noteId/recover", creationLimiter, Library.recoverNote);
router.patch("/:noteId/organization", Library.updateOrganization);
router.get("/:noteId", NoteController.getNote);
router.patch("/:noteId/private", NoteController.updatePrivateNote);
router.patch("/:noteId", NoteController.updateNote);
router.patch("/:noteId/favorite", NoteController.toggleFavorite);
router.post(
  "/:noteId/collaboration-token",
  collaborationTokenLimiter,
  NoteController.createRealtimeToken,
);
router.get("/:noteId/collaborators", NoteController.getCollaborators);
router.put("/:noteId/collaborators", NoteController.shareNote);
router.delete(
  "/:noteId/collaborators/:userId",
  NoteController.unshareNote,
);
router.delete("/:noteId", NoteController.deleteNote);

export default router;
