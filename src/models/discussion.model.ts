import { Schema, model, InferSchemaType } from "mongoose";

const post = new Schema({
  id: { type: String, required: true }, authorId: { type: String, default: "" },
  body: { type: String, maxlength: 4000, default: "" }, mentions: { type: [String], default: [] },
  createdAt: { type: Date, required: true }, editedAt: Date, deleted: { type: Boolean, default: false },
}, { _id: false });
const schema = new Schema({
  noteId: { type: Schema.Types.ObjectId, required: true, index: true },
  clientId: { type: String, required: true }, fingerprint: { type: String, required: true, select: false },
  revision: { type: Number, default: 0 }, resolved: { type: Boolean, default: false },
  posts: { type: [post], default: [], select: false },
}, { timestamps: true });
schema.index({ noteId: 1, clientId: 1 }, { unique: true });
schema.index({ "posts.authorId": 1 });
schema.index({ "posts.mentions": 1 });
schema.index({ updatedAt: -1, _id: -1 });
export type Discussion = InferSchemaType<typeof schema>;
export default model<Discussion>("Discussion", schema);
