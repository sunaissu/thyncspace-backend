import { model, Schema } from "mongoose";

const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  requestedAt: { type: Date, required: true },
  status: { type: String, enum: ["pending", "cancelled"], required: true },
  cancelledAt: { type: Date },
}, { timestamps: true });

export default model("PrivacyRequest", schema);
