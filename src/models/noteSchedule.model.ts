import { model, Schema } from "mongoose";
const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  slot: { type: Number, required: true, min: 0, max: 19 },
  title: { type: String, required: true, maxlength: 120 },
  templateId: { type: Schema.Types.ObjectId, ref: "Note", required: true },
  cadence: { type: String, enum: ["daily", "weekly"] as const, required: true },
  time: { type: String, required: true },
  weekday: { type: Number, min: 0, max: 6, default: 0 },
  isActive: { type: Boolean, default: true },
  nextRunAt: { type: Date, required: true, index: true },
  lastRunAt: { type: Date },
  lastNoteId: { type: Schema.Types.ObjectId, ref: "Note" },
  error: { type: String, default: "" },
}, { timestamps: true });
schema.index({ owner: 1, slot: 1 }, { unique: true });
export default model("NoteSchedule", schema);
