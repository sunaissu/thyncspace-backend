import express from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../util/auth.js";
import * as Attachments from "../controller/attachments.js";

const router = express.Router();
const changes = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, keyGenerator: req => req.user!.id, standardHeaders: "draft-8", legacyHeaders: false, skip: req => req.method === "GET", message: { error: "Too many attachment changes. Try again later." } });
const uploads = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: req => req.user!.id, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many uploads. Try again later." } });
router.use(requireAuth, changes);
router.get("/", Attachments.listAttachments);
router.post("/", uploads, Attachments.uploadAttachment);
router.get("/:attachmentId/content", Attachments.attachmentContent);
router.post("/:attachmentId/references", Attachments.referenceAttachment);
router.delete("/:attachmentId/references", Attachments.referenceAttachment);
router.delete("/:attachmentId", Attachments.deleteAttachment);
export default router;
