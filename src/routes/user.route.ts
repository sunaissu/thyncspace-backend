import express from 'express'
import * as UserController from '../controller/user.controller.js'
import { requireAuth } from '../util/auth.js'
import { listDeviceSessions, revokeDeviceSession } from '../controller/deviceSessions.js'

const router = express.Router()

router.get('/getUser', requireAuth, UserController.getProfile)
router.get('/sessions', requireAuth, listDeviceSessions)
router.delete('/sessions/:deviceId', requireAuth, revokeDeviceSession)
router.patch('/updateUsername', requireAuth, UserController.updateUsername)

export default router
