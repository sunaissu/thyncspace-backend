import express from "express";
import rateLimit from "express-rate-limit";
import * as Companion from "../controller/companion.js";
const router = express.Router();
// This router accepts a scoped bearer token only. Session cookies cannot grant
// access, and it exposes no general note, sharing, account or calculator routes.
router.use(Companion.requireCompanion);
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 360, keyGenerator: (_req, res) => res.locals.companion.owner, standardHeaders: "draft-8", legacyHeaders: false }));
router.get("/notes", Companion.listCompanion);
router.get("/notes/:noteId", Companion.documentCompanion);
router.patch("/notes/:noteId", Companion.documentCompanion);
router.get("/notes/:noteId/attachments", Companion.filesCompanion);
router.get("/notes/:noteId/attachments/:attachmentId", Companion.filesCompanion);
router.delete("/connection", Companion.disconnectCompanion);
export default router;
