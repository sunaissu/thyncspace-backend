import { InferSchemaType, model, Schema } from "mongoose";
import { NoteStatus, NoteType, PermissionLevel } from "../types/_enums.js";

const noteSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    type: {
      type: String,
      enum: Object.values(NoteType),
      default: NoteType.Document,
    },
    content: { type: String, maxlength: 1024 * 1024 },
    status: {
      type: String,
      enum: Object.values(NoteStatus),
      default: NoteStatus.Active,
    },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sharedWith: [
      {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        permission: {
          type: String,
          enum: Object.values(PermissionLevel),
          default: PermissionLevel.Viewer,
        },
      },
    ],
    favoritedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
    collaborationState: { type: Buffer, select: false },
  },
  { timestamps: true },
);

type Note = InferSchemaType<typeof noteSchema>;

export default model<Note>("Note", noteSchema);
