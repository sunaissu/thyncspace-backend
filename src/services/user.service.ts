import createHttpError from 'http-errors'
import * as userRepository from '../repositories/user.repository'
import { validateUsername } from '../util/validation'

export const getUserProfile = async (userId: string) => {
  const user = await userRepository.findUserById(userId)
  if (!user) {
    throw createHttpError(404, 'User not found')
  }

  return user
}

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
