import { model, Schema } from "mongoose";

const job = new Schema({
  _id: { type: Schema.Types.ObjectId, ref: "User" },
  clientId: { type: String, required: true }, digest: { type: String, required: true },
  expected: { type: Number, required: true }, next: { type: Number, default: 0 },
  notes: { type: Number, default: 0 }, files: { type: Number, default: 0 }, bytes: { type: Number, default: 0 }, fileBytes: { type: Number, default: 0 },
  status: { type: String, enum: ["loading", "complete"], default: "loading" },
  noteIds: { type: [String], default: [] }, reusedFiles: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
const item = new Schema({
  owner: { type: Schema.Types.ObjectId, required: true }, clientId: { type: String, required: true },
  index: { type: Number, required: true }, sourceId: { type: String, required: true },
  kind: { type: String, enum: ["note", "attachment"], required: true }, hash: { type: String, required: true },
  title: { type: String }, sourcePath: { type: String },
  payload: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true, expires: 0 },
});
item.index({ owner: 1, clientId: 1, index: 1 }, { unique: true });
item.index({ owner: 1, clientId: 1, kind: 1, sourceId: 1 }, { unique: true });
export const ArchiveImport = model("ArchiveImport", job);
export const ArchiveItem = model("ArchiveItem", item);
