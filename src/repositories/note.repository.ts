import Notes from "../models/note.model.js";
import { NoteStatus } from "../types/_enums.js";
import mongoose from "mongoose";

export const findNotesByOwner = async (userId: string) => {
  return Notes.find({ owner: userId, status: NoteStatus.Active });
};

export const findSharedNotesByUser = async (userId: string) => {
  return Notes.find({
    "sharedWith.userId": userId,
    status: NoteStatus.Active,
  });
};

export const findFavoritedNotesByUser = async (userId: string) => {
  return Notes.find({
    favoritedBy: userId,
    status: NoteStatus.Active,
    $or: [
      { owner: userId },
      { "sharedWith.userId": userId },
    ],
  });
};

export const toggleFavorite = async (noteId: string, userId: string) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  return Notes.findOneAndUpdate(
    {
      _id: noteId,
      status: NoteStatus.Active,
      $or: [{ owner: userObjectId }, { "sharedWith.userId": userObjectId }],
    },
    [
      {
        $set: {
          favoritedBy: {
            $cond: [
              { $in: [userObjectId, { $ifNull: ["$favoritedBy", []] }] },
              { $setDifference: [{ $ifNull: ["$favoritedBy", []] }, [userObjectId]] },
              { $setUnion: [{ $ifNull: ["$favoritedBy", []] }, [userObjectId]] },
            ],
          },
        },
      },
    ],
    { new: true },
  );
};
