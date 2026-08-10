import passport from "passport";
import express from 'express'
import * as AuthController from '../controller/auth.controller.js'
import env from "../util/validateEnv.js";
import { requireAuth } from "../util/auth.js";
import rateLimit from "express-rate-limit";
import { issueCsrfToken } from "../util/csrf.js";

const router = express.Router()

const loginLimiter = rateLimit({
    windowMs: 30 * 60 * 1000, // 30 minutes
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 56,
    message: { error: 'Too many requests, please try again after a while.' },
})

const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 56,
    message: { error: 'Too many registration attempts; please try again later.' },
})

const csrfTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
})

router.get('/csrf-token', csrfTokenLimiter, issueCsrfToken)
router.post('/register', registrationLimiter, AuthController.signup)
router.post('/login', loginLimiter, AuthController.login)
router.get('/google',
    passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: env.CLIENT_URL + '/login' }),
    function (req, res) {
        res.redirect(env.CLIENT_URL + '/notes');
    });

router.post('/logout', requireAuth, AuthController.logout)

export default router
