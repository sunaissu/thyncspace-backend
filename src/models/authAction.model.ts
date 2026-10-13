import { model, Schema } from "mongoose";

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  purpose: { type: String, enum: ["reset", "verify"], required: true },
  email: { type: String, required: true, select: false },
  tokenHash: { type: String, required: true, unique: true, select: false },
  credentialVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

export default model("AuthAction", schema);
