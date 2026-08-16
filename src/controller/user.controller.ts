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
  res.status(200).json({
    user: {
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
  res.status(200).json({
    message: 'Username updated successfully',
    user: userResponse(updatedUser),
  })
}
