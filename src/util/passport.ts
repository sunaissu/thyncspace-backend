import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import env from "./validateEnv.js";
import * as authService from "../services/auth.service.js";
import * as userRepository from "../repositories/user.repository.js";

passport.use(
  new GoogleStrategy(
    {
      clientID: env.GOOGLE_AUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
      state: true,
      pkce: true,
    },
    async (_accessToken, _refreshToken, profile, callback) => {
      try {
        const user = await authService.authenticateWithGoogle({
          googleId: profile.id,
          email: profile.emails?.find((email) => email.verified)?.value ?? "",
          displayName: profile.displayName ?? "",
        });
        callback(null, user as Express.User);
      } catch (error) {
        callback(error, undefined);
      }
    },
  ),
);

passport.serializeUser((user, callback) => {
  callback(null, user.id);
});

passport.deserializeUser(async (userId: string, callback) => {
  try {
    const user = await userRepository.findUserById(String(userId));
    if (!user) return callback(null, false);
    return callback(null, {
      email: user.email,
      id: user.id,
      username: user.username,
    });
  } catch (error) {
    return callback(error);
  }
});
