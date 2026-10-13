import { model, Schema } from "mongoose";

const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, required: true, maxlength: 200 },
  mime: { type: String, required: true },
  bytes: { type: Number, required: true },
  hash: { type: String, required: true, select: false },
  data: { type: Buffer, required: true, select: false },
  references: { type: [String], default: [], index: true },
  ocrText: { type: String, maxlength: 50000, select: false },
  indexedAt: { type: Date },
  ocrRevision: { type: Number, default: 0, select: false },
}, { timestamps: true });
schema.index({ owner: 1, hash: 1 }, { unique: true });
export default model("Attachment", schema);
