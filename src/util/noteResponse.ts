import type { Document } from "mongoose";

type SerializableNote = Document & {
  favoritedBy?: Array<{ toString(): string }>;
  owner: { toString(): string };
  sharedWith?: Array<{
    permission: string;
    userId: { toString(): string };
  }>;
  toObject(): Record<string, unknown>;
};

export const toNoteResponse = (note: SerializableNote, userId: string) => {
  const value = note.toObject();
  const isOwner = note.owner.toString() === userId;
  const sharedWith = (note.sharedWith ?? [])
    .filter((entry) => isOwner || entry.userId.toString() === userId)
    .map((entry) => ({
      userId: entry.userId,
      permission: entry.permission,
    }));
  const isFavorited = (note.favoritedBy ?? []).some(
    (favoriteUserId) => favoriteUserId.toString() === userId,
  );

  delete value.__v;
  delete value.history;
  delete value.activity;
  delete value.attachmentRevision;
  delete value.generationKey;
  if (!isOwner) { delete value.notebook; delete value.tags; delete value.sourcePath; delete value.isTemplate; delete value.isArchived; }
  delete value.collaborationState;

  return {
    ...value,
    sharedWith,
    favoritedBy: isFavorited ? [userId] : [],
  };
};
