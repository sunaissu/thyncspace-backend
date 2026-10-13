import { Schema, model } from "mongoose";
const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, required: true, maxlength: 80 },
  slot: { type: Number, required: true, min: 0, max: 19, select: false },
  clientId: { type: String, required: true, select: false },
  revision: { type: Number, default: 0 },
  members: { type: [new Schema({ userId: { type: Schema.Types.ObjectId, required: true }, permission: { type: String, enum: ["viewer", "editor"], required: true } }, { _id: false })], default: [] },
}, { timestamps: true });
schema.index({ owner: 1, slot: 1 }, { unique: true });
schema.index({ owner: 1, clientId: 1 }, { unique: true });
schema.index({ "members.userId": 1 });
export default model("SharedNotebook", schema);
