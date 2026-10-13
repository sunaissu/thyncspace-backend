import { model, Schema } from "mongoose";
export default model("AttachmentQuota", new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  count: { type: Number, default: 0 }, bytes: { type: Number, default: 0 },
}));
