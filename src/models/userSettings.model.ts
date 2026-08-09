import { InferSchemaType, model, Schema } from 'mongoose'
import { DefaultView, Theme } from '../types/_enums'

const userSettingsSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    theme: { type: String, enum: Object.values(Theme), default: Theme.System },
    defaultView: { type: String, enum: Object.values(DefaultView), default: DefaultView.Grid },
  },
  { timestamps: true }
)

type UserSettings = InferSchemaType<typeof userSettingsSchema>

export default model<UserSettings>('UserSettings', userSettingsSchema)
