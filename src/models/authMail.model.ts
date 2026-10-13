import { model, Schema } from "mongoose";

const schema = new Schema({
  dedupe: { type: String, required: true, unique: true },
  emailKey: { type: String, required: true, index: true },
  kind: { type: String, enum: ["reset", "verify", "changed"], required: true },
  payload: { type: String, required: true, select: false },
  availableAt: { type: Date, required: true },
  leaseUntil: { type: Date, default: () => new Date(0) },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

export default model("AuthMail", schema);
