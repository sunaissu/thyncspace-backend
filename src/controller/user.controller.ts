import { Request, Response } from 'express'
import * as userService from '../services/user.service'

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
  const userId = (req.user as { id: string }).id

  const user = await userService.getUserProfile(userId)
  res.status(200).json({ user: userResponse(user) })
}

export const updateUsername = async (req: Request, res: Response) => {
  const userId = (req.user as { id: string }).id
  const newUsername = req.body?.newUsername

  const updatedUser = await userService.updateUsername(userId, newUsername)
  res.status(200).json({
    message: 'Username updated successfully',
    user: userResponse(updatedUser),
  })
}
