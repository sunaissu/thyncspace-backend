import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import helmet from "helmet";
import morgan from "morgan";
import createHttpError, { isHttpError } from "http-errors";
import cors from "cors";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";
import rateLimit from "express-rate-limit";
import noteRoutes from "./routes/notes.route.js";
import userRoutes from "./routes/user.route.js";
import authRoutes from "./routes/auth.route.js";
import env from "./util/validateEnv.js";
import { APP_VERSION } from "./util/appVersion.js";
import { requireCsrfProtection } from "./util/csrf.js";
import { SESSION_COOKIE_NAME } from "./util/session.js";
import { getCacheStatus } from "./util/cache.js";
import { summarizeError } from "./util/errorLogging.js";
import { sanitizeRequestTarget } from "./util/requestLogging.js";
import "./util/passport.js";
import { trackDeviceSession } from "./util/deviceSessions.js";

const app = express();
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    strictTransportSecurity:
      env.ENVIRONMENT === "production"
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
  }),
);
app.use(express.json({ limit: "5mb", strict: true }));
morgan.token("safe-url", (request) =>
  sanitizeRequestTarget((request as Request).originalUrl ?? request.url),
);
const requestLogFormat =
  env.ENVIRONMENT === "production"
    ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
    : ":method :safe-url :status :response-time ms - :res[content-length]";
app.use(morgan(requestLogFormat));

app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  message: { error: "Too many requests; please try again later." },
});
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
}, apiLimiter);

app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    status: "ok",
    version: APP_VERSION,
    cache: getCacheStatus(),
  });
});
app.get("/readyz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: "not-ready", version: APP_VERSION });
  }
  return res.status(200).json({
    status: "ready",
    version: APP_VERSION,
    cache: getCacheStatus(),
  });
});

app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      maxAge: SESSION_MAX_AGE_MS,
      secure: env.ENVIRONMENT === "production",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
    store: MongoStore.create({
      mongoUrl: env.MONGO_CONN,
      dbName: env.MONGO_DB_NAME,
      ttl: SESSION_MAX_AGE_MS / 1000,
      touchAfter: 24 * 60 * 60,
      autoRemove: "native",
    }),
  }),
);

app.use(passport.initialize());
app.use(passport.session());
app.use(trackDeviceSession);
app.use(requireCsrfProtection);

app.use("/api/notes", noteRoutes);
app.use("/api/users", userRoutes);
app.use("/api/auth", authRoutes);

app.use((_req, _res, next) => {
  next(createHttpError(404, "Endpoint not found"));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled request error", summarizeError(error));

  let errorMessage = "An unexpected error occurred";
  let statusCode = 500;

  if (isHttpError(error)) {
    statusCode = error.status;
    errorMessage = error.message;
  } else if (error instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    errorMessage = "The submitted data is invalid";
  } else if (error instanceof mongoose.Error.CastError) {
    statusCode = 400;
    errorMessage = "The submitted identifier is invalid";
  } else if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  ) {
    statusCode = 409;
    errorMessage = "A record with that value already exists";
  }

  res.status(statusCode).json({ error: errorMessage });
});

export default app;
