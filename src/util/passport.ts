import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import env from "./validateEnv.js";
import * as authService from "../services/auth.service.js";
import { loadSessionIdentity } from "./sessionIdentity.js";

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
  callback(null, { id: user.id, version: user.credentialVersion ?? 0 });
});

passport.deserializeUser(async (identity: unknown, callback) => {
  try { callback(null, await loadSessionIdentity(identity) || false); }
  catch (error) { callback(error); }
});
