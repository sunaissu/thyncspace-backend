import { manageCompanion } from "../controller/companion.js";
import * as Archive from "../controller/workspaceArchive.js";
import * as Ai from "../controller/passageAi.js";
import * as Notebooks from "../controller/sharedNotebooks.js";
import * as Discussions from "../controller/discussions.js";
import * as Embeds from "../controller/noteEmbeds.js";
import * as Reminders from "../controller/reminders.js";
import { getNoteActivity } from "../controller/noteActivity.js";
import express from "express";
import rateLimit from "express-rate-limit";
import * as NoteController from "../controller/notes.js";
import { requireAuth } from "../util/auth.js";

import * as Library from "../controller/noteLibrary.js";
import * as Workspace from "../controller/workspace.js";
import * as Schedules from "../controller/noteSchedules.js";
import { captureNote } from "../controller/capture.js";

const router = express.Router();

const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  skip: (req) => ["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/archive/import",
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
const archiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 360, keyGenerator: req => req.user!.id, standardHeaders: "draft-8", legacyHeaders: false });
const archiveExportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 2, keyGenerator: req => req.user!.id, standardHeaders: "draft-8", legacyHeaders: false });
router.get("/companion-connections", manageCompanion);
router.post("/companion-connections", creationLimiter, manageCompanion);
router.delete("/companion-connections/:grantId", manageCompanion);
router.get("/archive/export", archiveExportLimiter, Archive.downloadArchive);
router.get("/archive/import", Archive.importArchive);
router.post("/archive/import", archiveLimiter, Archive.importArchive);

const aiAccountLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, keyGenerator: req => req.user!.id, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "You have reached the limit of five AI actions per hour" } });
const aiWorkspaceLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, keyGenerator: () => "workspace", standardHeaders: "draft-8", legacyHeaders: false, message: { error: "The workspace AI limit was reached. Try again later" } });
router.get("/ai-settings", Ai.aiSettings);
router.post("/:noteId/ai", aiAccountLimiter, aiWorkspaceLimiter, Ai.passageAction);
router.get("/notebooks", Notebooks.listNotebooks);
router.post("/notebooks", creationLimiter, Notebooks.createNotebook);
router.get("/notebooks/:notebookId", Notebooks.getNotebook);
router.patch("/notebooks/:notebookId", Notebooks.changeNotebook);
router.get("/discussions", Discussions.listDiscussions);
router.get("/:noteId/discussions/:threadId", Discussions.getDiscussion);
router.post("/:noteId/discussions", Discussions.changeDiscussion);
router.patch("/:noteId/discussions/:threadId", Discussions.changeDiscussion);
router.get("/reminders", Reminders.listReminders);
router.patch("/reminders", Reminders.updateReminders);
router.get("/", NoteController.getNotes);
router.post("/daily", creationLimiter, Schedules.dailyNote);
router.post("/capture", creationLimiter, captureNote);
router.get("/schedules", Schedules.listSchedules);
router.post("/schedules", creationLimiter, Schedules.createSchedule);
router.patch("/schedules/:scheduleId", Schedules.changeSchedule);
router.delete("/schedules/:scheduleId", Schedules.changeSchedule);
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
router.get("/:noteId/embeds", Embeds.listEmbeds);
router.get("/:noteId/embeds/:sourceId", Embeds.previewEmbed);
router.patch("/:noteId/embeds", Embeds.updateEmbeds);
router.get("/:noteId/activity", getNoteActivity);
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
