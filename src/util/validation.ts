import createHttpError from "http-errors";
import { NoteType } from "../types/_enums.js";

export const MAX_NOTE_TITLE_LENGTH = 200;
export const MAX_NOTE_CONTENT_BYTES = 1024 * 1024;
export const MAX_IMPORT_NOTES = 100;
export const MAX_IMPORT_CONTENT_BYTES = 4 * 1024 * 1024;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export const normalizeEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export const validateEmail = (value: unknown) => {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw createHttpError(400, "Enter a valid email address");
  }
  return email;
};

export const normalizeUsername = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

export const validateUsername = (value: unknown) => {
  const username = normalizeUsername(value);
  if (
    username.length < 2 ||
    username.length > 50 ||
    CONTROL_CHARACTER_PATTERN.test(username)
  ) {
    throw createHttpError(
      400,
      "Username must be between 2 and 50 characters and contain no control characters",
    );
  }
  return username;
};

export const validateRegistrationPassword = (value: unknown) => {
  if (typeof value !== "string" || value.length < 12) {
    throw createHttpError(400, "Password must be at least 12 characters");
  }
  if (value.length > 128 || Buffer.byteLength(value, "utf8") > 72) {
    throw createHttpError(400, "Password is too long");
  }
  return value;
};

export const validateLoginPassword = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    Buffer.byteLength(value, "utf8") > 72
  ) {
    throw createHttpError(400, "Enter a valid password");
  }
  return value;
};

export const validateNoteTitle = (value: unknown) => {
  if (typeof value !== "string") {
    throw createHttpError(400, "Note title must be text");
  }
  const title = value.trim();
  if (!title || title.length > MAX_NOTE_TITLE_LENGTH) {
    throw createHttpError(
      400,
      `Note title must be between 1 and ${MAX_NOTE_TITLE_LENGTH} characters`,
    );
  }
  return title;
};

export const validateNoteContent = (value: unknown) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw createHttpError(400, "Note content must be text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_NOTE_CONTENT_BYTES) {
    throw createHttpError(413, "Note content is too large");
  }
  return value;
};

export const validateNoteType = (value: unknown) => {
  if (value === undefined) return NoteType.Document;
  if (!Object.values(NoteType).includes(value as NoteType)) {
    throw createHttpError(400, "Note type must be document or whiteboard");
  }
  return value as NoteType;
};

export const validateShareIdentifier = (value: unknown) => {
  if (typeof value !== "string") {
    throw createHttpError(400, "Username or email is required");
  }
  const identifier = value.trim();
  if (!identifier || identifier.length > 254 || CONTROL_CHARACTER_PATTERN.test(identifier)) {
    throw createHttpError(400, "Enter a valid username or email");
  }
  return identifier;
};
