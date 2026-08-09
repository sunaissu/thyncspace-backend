import type { Document } from "mongoose";

type SerializableNote = Document & {
  favoritedBy?: Array<{ toString(): string }>;
  sharedWith?: Array<{
    permission: string;
    userId: { toString(): string };
  }>;
  toObject(): Record<string, unknown>;
};

export const toNoteResponse = (note: SerializableNote, userId: string) => {
  const value = note.toObject();
  const sharedWith = (note.sharedWith ?? [])
    .filter((entry) => entry.userId.toString() === userId)
    .map((entry) => ({
      userId: entry.userId,
      permission: entry.permission,
    }));
  const isFavorited = (note.favoritedBy ?? []).some(
    (favoriteUserId) => favoriteUserId.toString() === userId,
  );

  delete value.__v;
  delete value.collaborationState;

  return {
    ...value,
    sharedWith,
    favoritedBy: isFavorited ? [userId] : [],
  };
};
