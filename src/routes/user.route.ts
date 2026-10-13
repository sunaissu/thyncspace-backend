import express from 'express'
import rateLimit from 'express-rate-limit'
import * as Privacy from '../controller/privacy.js'
import * as UserController from '../controller/user.controller.js'
import { requireAuth } from '../util/auth.js'
import { listDeviceSessions, revokeDeviceSession } from '../controller/deviceSessions.js'

const router = express.Router()

const privacyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => req.user!.id, message: { error: 'Too many privacy requests; try again later.' } })
router.get('/privacy/export', requireAuth, privacyLimiter, Privacy.exportAccount)
router.get('/privacy/deletion', requireAuth, Privacy.getDeletionRequest)
router.post('/privacy/deletion', requireAuth, privacyLimiter, Privacy.changeDeletionRequest)
router.delete('/privacy/deletion', requireAuth, Privacy.changeDeletionRequest)

router.get('/getUser', requireAuth, UserController.getProfile)
router.get('/sessions', requireAuth, listDeviceSessions)
router.delete('/sessions/:deviceId', requireAuth, revokeDeviceSession)
router.patch('/updateUsername', requireAuth, UserController.updateUsername)

export default router
