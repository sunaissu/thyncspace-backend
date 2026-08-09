import express from 'express'
import * as UserController from '../controller/user.controller'
import { requireAuth } from '../util/auth'

const router = express.Router()

router.get('/getUser', requireAuth, UserController.getProfile)
router.patch('/updateUsername', requireAuth, UserController.updateUsername)

export default router
