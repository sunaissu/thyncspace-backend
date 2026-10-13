import { model, Schema } from "mongoose";

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  credentialVersion: { type: Number, default: 0 },
  sessionHash: { type: String, required: true, unique: true, select: false },
  userAgent: { type: String, default: "Unknown browser", maxlength: 300 },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, expires: 0 },
  revokedAt: { type: Date, default: null },
});
export default model("DeviceSession", schema);
