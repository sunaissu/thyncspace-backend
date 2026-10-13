import { InferSchemaType, model, Schema } from "mongoose";

const userSchema = new Schema(
  {
    credentialVersion: { type: Number, default: 0, min: 0 },
    emailVerifiedAt: { type: Date, default: null },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      select: false,
    },
  },
  {
    timestamps: true,
    collation: { locale: "en", strength: 2 },
  },
);

type User = InferSchemaType<typeof userSchema>;

export default model<User>("User", userSchema);
