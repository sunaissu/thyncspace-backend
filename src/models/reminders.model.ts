import { model, Schema } from "mongoose";

const entry = new Schema({
  id: { type: String, required: true }, noteId: { type: String, required: true },
  dueAt: { type: Date, required: true }, repeatDays: { type: Number, default: 0 },
  taskLine: { type: Number }, sourceText: { type: String, maxlength: 2000 },
  completedAt: { type: Date }, createdAt: { type: Date, required: true },
}, { _id: false });
export default model("ReminderPreference", new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  revision: { type: Number, default: 0 }, entries: { type: [entry], default: [] },
}, { optimisticConcurrency: true, timestamps: true }));
