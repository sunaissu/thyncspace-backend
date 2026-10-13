import { model, Schema } from "mongoose";
const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true, maxlength: 10 },
  noteId: { type: Schema.Types.ObjectId, ref: "Note", required: true },
});
schema.index({ owner: 1, date: 1 }, { unique: true });
export default model("DailyNote", schema);
