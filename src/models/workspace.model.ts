import { model, Schema } from "mongoose";

const workspaceSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  revision: { type: Number, default: 0 },
  pinned: { type: [String], default: [] },
  recent: { type: [new Schema({ noteId: { type: String, required: true }, openedAt: { type: Date, required: true } }, { _id: false })], default: [] },
  searches: { type: [new Schema({
    id: { type: String, required: true }, name: { type: String, required: true }, query: { type: String, default: "" },
    notebook: { type: String, default: "" }, tag: { type: String, default: "" },
    owner: { type: String, default: "all" }, type: { type: String, default: "all" },
    view: { type: String, default: "all" },
    from: { type: String, default: "" }, to: { type: String, default: "" },
  }, { _id: false })], default: [] },
}, { optimisticConcurrency: true, timestamps: true });

export default model("WorkspacePreference", workspaceSchema);
