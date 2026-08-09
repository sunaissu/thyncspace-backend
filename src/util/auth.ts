import { Request, Response, NextFunction } from 'express'
import createHttpError from 'http-errors'

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.isAuthenticated()) {
        return next()
    }

    throw createHttpError(401, 'User not authenticated')
}
