import { InferSchemaType, model, Schema } from 'mongoose'
import { AuthProvider } from '../types/_enums'

const userAuthSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    password: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true, select: false },
    authProvider: { type: String, enum: Object.values(AuthProvider), default: AuthProvider.Local },
  },
  { timestamps: true }
)

type UserAuth = InferSchemaType<typeof userAuthSchema>

export default model<UserAuth>('UserAuth', userAuthSchema)
