import express from 'express'
import * as UserController from '../controller/user.controller.js'
import { requireAuth } from '../util/auth.js'

const router = express.Router()

router.get('/getUser', requireAuth, UserController.getProfile)
router.patch('/updateUsername', requireAuth, UserController.updateUsername)

export default router
