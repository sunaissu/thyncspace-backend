import { ClientSession, Types } from 'mongoose'
import UserAuth from '../models/userAuth.model'

export const createUserAuth = async (
    authData: {
        userId: Types.ObjectId;
        password?: string;
        googleId?: string;
        authProvider: string
    },
    session?: ClientSession
) => {
    const [auth] = await UserAuth.create([authData], { session })
    return auth
}

export const findAuthByUserId = async (userId: Types.ObjectId) => {
    return UserAuth.findOne({ userId }).select('+password')
}

export const findAuthByGoogleId = async (googleId: string) => {
    return UserAuth.findOne({ googleId }).select('+googleId')
}
