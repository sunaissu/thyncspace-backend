import { model, Schema } from "mongoose";
const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, required: true, ref: "User" },
  name: { type: String, required: true, maxlength: 80 },
  clientId: { type: String, required: true }, slot: { type: Number, required: true, min: 0, max: 4, select: false },
  tokenHash: { type: String, required: true, unique: true, select: false },
  credentialVersion: { type: Number, required: true, select: false },
  noteIds: { type: [String], required: true }, attachments: { type: Boolean, default: false },
  lastUsedAt: { type: Date }, expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
schema.index({ owner: 1, slot: 1 }, { unique: true });
schema.index({ owner: 1, clientId: 1 }, { unique: true });
export default model("CompanionGrant", schema);
