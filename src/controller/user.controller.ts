import UserModel from "../models/user.model.js";
import { hasWorkspaceAccess } from "../util/workspaceAccess.js";
import { refreshPresenceIdentity } from "../collaboration/server.js";
import { Request, Response } from 'express'
import * as userService from '../services/user.service.js'
import { cacheKeys, deleteCachedKeys } from '../util/cache.js'

const userResponse = (user: {
  _id: { toString(): string };
  email?: string;
  username: string;
}) => ({
  _id: user._id.toString(),
  email: user.email,
  username: user.username,
})

export const getProfile = async (req: Request, res: Response) => {
  const user = req.user as { email: string; id: string; username: string }
  const current = await UserModel.findById(user.id).select("emailVerifiedAt +suspendedAt").exec();
  res.status(200).json({
    user: {
      workspaceAccess: Boolean(current && hasWorkspaceAccess(current)),
      _id: user.id,
      email: user.email,
      username: user.username,
    },
  })
}

export const updateUsername = async (req: Request, res: Response) => {
  const userId = (req.user as { id: string }).id
  const newUsername = req.body?.newUsername

  const updatedUser = await userService.updateUsername(userId, newUsername)
  await deleteCachedKeys(cacheKeys.sessionUser(userId))
  refreshPresenceIdentity(userId, updatedUser.username)
  res.status(200).json({
    message: 'Username updated successfully',
    user: userResponse(updatedUser),
  })
}
