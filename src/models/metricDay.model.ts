import { InferSchemaType, model, Schema } from "mongoose";
const schema = new Schema({ subject: { type: String, required: true }, day: { type: String, required: true }, counters: { type: Map, of: Number, default: {} }, total: { type: Number, default: 0 }, expiresAt: { type: Date, required: true } }, { timestamps: false });
schema.index({ subject: 1, day: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default model<InferSchemaType<typeof schema>>("MetricDay", schema);
