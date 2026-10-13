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
    contentRevision: { type: Number, default: 0, min: 0 },
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
    notebook: { type: String, default: "", maxlength: 80 },
    sourcePath: { type: String, maxlength: 1024 },
    isTemplate: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    trashedAt: { type: Date },
    history: { type: [new Schema({
      title: { type: String, required: true },
      content: { type: String, default: "" },
      savedAt: { type: Date, required: true },
      label: { type: String, maxlength: 80 },
    })], select: false, default: [] },
    collaborationState: { type: Buffer, select: false },
  },
  { timestamps: true },
);

type Note = InferSchemaType<typeof noteSchema>;

export default model<Note>("Note", noteSchema);
