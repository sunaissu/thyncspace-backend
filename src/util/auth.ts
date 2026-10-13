import { Request, Response, NextFunction } from 'express'
import createHttpError from 'http-errors'

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.isAuthenticated()) {
        return next()
    }

    throw createHttpError(401, 'User not authenticated')
}

// An additional stale-tab check, never a replacement for session authorization.
export const requireMatchingAccount = (req: Request, _res: Response, next: NextFunction) => {
    const expected = req.get('x-account-id')
    if (expected && req.user && expected !== req.user.id) return next(createHttpError(409, 'The signed-in account changed. Refresh your session before saving.'))
    next()
}
