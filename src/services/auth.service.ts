import bcrypt from "bcrypt";
import mongoose from "mongoose";
import createHttpError from "http-errors";
import * as userRepository from "../repositories/user.repository.js";
import * as userAuthRepository from "../repositories/userAuth.repository.js";
import {
  normalizeUsername,
  validateEmail,
  validateLoginPassword,
  validateRegistrationPassword,
  validateUsername,
} from "../util/validation.js";
import { AuthProvider } from "../types/_enums.js";

interface SignupData {
  username?: string;
  email?: string;
  password?: string;
}

interface LoginData {
  email?: string;
  password?: string;
}

export interface GoogleAuthProfile {
  googleId: string;
  email: string;
  displayName: string;
}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

// Comparing against a startup-generated hash keeps failed logins from becoming
// a reliable email-existence timing oracle.
const dummyPasswordHash = bcrypt.hash("thyncspace-invalid-login", 12);

const availableGoogleUsername = async (displayName: string, email: string) => {
  const cleanedDisplayName = normalizeUsername(displayName)
    .replace(/\p{Cc}/gu, "")
    .slice(0, 42);
  const emailName = email.split("@")[0].replace(/[^\p{L}\p{N}._-]/gu, "");
  const base = (cleanedDisplayName.length >= 2 ? cleanedDisplayName : emailName) || "User";

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = `${base.slice(0, 50 - suffix.length)}${suffix}`;
    if (!(await userRepository.findUserByUsername(candidate))) return candidate;
  }

  throw createHttpError(409, "Unable to allocate a username for this account");
};

export const signUpUser = async ({ username, email, password }: SignupData) => {
  const normalizedUsername = validateUsername(username);
  const normalizedEmail = validateEmail(email);
  const validPassword = validateRegistrationPassword(password);

  const existingUsername = await userRepository.findUserByUsername(normalizedUsername);
  if (existingUsername) throw createHttpError(409, "Username already exists");

  const existingUser = await userRepository.findUserByEmail(normalizedEmail);
  if (existingUser) {
    const existingAuth = await userAuthRepository.findAuthByUserId(existingUser._id);
    if (existingAuth?.authProvider === "google") {
      throw createHttpError(
        409,
        "An account with this email uses Google sign-in",
      );
    }
    throw createHttpError(409, "An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(validPassword, 12);
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const newUser = await userRepository.createUser(
      { username: normalizedUsername, email: normalizedEmail },
      session,
    );
    await userAuthRepository.createUserAuth(
      {
        userId: newUser._id,
        password: passwordHash,
        authProvider: "local",
      },
      session,
    );
    await session.commitTransaction();
    return newUser;
  } catch (error) {
    await session.abortTransaction();
    if (isDuplicateKeyError(error)) {
      throw createHttpError(409, "Username or email is already registered");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const loginUser = async ({ email, password }: LoginData) => {
  const normalizedEmail = validateEmail(email);
  const validPassword = validateLoginPassword(password);
  const user = await userRepository.findUserByEmail(normalizedEmail);
  const auth = user
    ? await userAuthRepository.findAuthByUserId(user._id)
    : null;
  const passwordMatches = await bcrypt.compare(
    validPassword,
    auth?.password ?? (await dummyPasswordHash),
  );
  if (
    !user ||
    !auth ||
    auth.authProvider !== AuthProvider.Local ||
    !passwordMatches
  ) {
    throw createHttpError(401, "Invalid credentials");
  }
  return user;
};

export const authenticateWithGoogle = async (profile: GoogleAuthProfile) => {
  if (!profile.googleId) throw createHttpError(400, "Missing Google profile ID");
  const email = validateEmail(profile.email);

  const existingAuth = await userAuthRepository.findAuthByGoogleId(profile.googleId);
  if (existingAuth) {
    const user = await userRepository.findUserById(existingAuth.userId.toString());
    if (!user) throw createHttpError(404, "User not found");
    return user;
  }

  if (await userRepository.findUserByEmail(email)) {
    throw createHttpError(
      409,
      "An account with this email already exists; sign in with its existing method",
    );
  }

  const username = await availableGoogleUsername(profile.displayName, email);
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const newUser = await userRepository.createUser({ username, email }, session);
    await userAuthRepository.createUserAuth(
      {
        userId: newUser._id,
        googleId: profile.googleId,
        authProvider: "google",
      },
      session,
    );
    await session.commitTransaction();
    return newUser;
  } catch (error) {
    await session.abortTransaction();
    if (isDuplicateKeyError(error)) {
      throw createHttpError(409, "This Google account is already registered");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};
