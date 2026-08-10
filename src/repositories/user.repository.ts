import { ClientSession } from "mongoose";
import User from "../models/user.model.js";
import { normalizeEmail, normalizeUsername } from "../util/validation.js";

export const findUserById = async (userId: string) => {
  return User.findById(userId).select("+email");
};

export const findUserByUsername = async (username: string) => {
  return User.findOne({ username: normalizeUsername(username) }).collation({
    locale: "en",
    strength: 2,
  });
};

export const findUserByEmail = async (email: string) => {
  return User.findOne({ email: normalizeEmail(email) })
    .collation({ locale: "en", strength: 2 })
    .select("+email");
};

export const createUser = async (
    userData: { username: string; email: string },
    session?: ClientSession
) => {
  const [user] = await User.create(
    [{
      username: normalizeUsername(userData.username),
      email: normalizeEmail(userData.email),
    }],
    { session },
  );
  return user;
};

export const updateUsername = async (userId: string, username: string) => {
  return User.findByIdAndUpdate(
    userId,
    { username: normalizeUsername(username) },
    { new: true, runValidators: true },
  ).select("+email");
};
