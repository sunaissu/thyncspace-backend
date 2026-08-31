import createHttpError from 'http-errors'
import * as userRepository from '../repositories/user.repository.js'
import { validateUsername } from '../util/validation.js'

export const updateUsername = async (userId: string, newUsername: string) => {
  const username = validateUsername(newUsername)

  const existingUsername = await userRepository.findUserByUsername(username)
  if (existingUsername && existingUsername._id.toString() !== userId) {
    throw createHttpError(409, 'Username is already taken')
  }

  const user = await userRepository.updateUsername(userId, username)
  if (!user) {
    throw createHttpError(404, 'User not found')
  }

  return user
}
