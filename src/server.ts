import { createServer } from "http";
import mongoose from "mongoose";
import app from "./app.js";
import {
  attachCollaborationServer,
  shutdownCollaborationServer,
} from "./collaboration/server.js";
import { connectCache, disconnectCache } from "./util/cache.js";
import env from "./util/validateEnv.js";
import Attachment from "./models/attachment.model.js";
import AttachmentQuota from "./models/attachmentQuota.model.js";
import User from "./models/user.model.js";
import UserAuth from "./models/userAuth.model.js";
import AuthAction from "./models/authAction.model.js";
import AuthMail from "./models/authMail.model.js";
import { startAuthMailWorker, stopAuthMailWorker } from "./services/authMail.js";
import PrivacyRequest from "./models/privacyRequest.model.js";
import DeviceSession from "./models/deviceSession.model.js";
import Workspace from "./models/workspace.model.js";
import Note from "./models/note.model.js";
import Daily from "./models/dailyNote.model.js";
import NoteSchedule from "./models/noteSchedule.model.js";
import { startNoteScheduler, stopNoteScheduler } from "./services/noteSchedules.js";

const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
attachCollaborationServer(server);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  let closeError: Error | undefined;
  const httpClosed = new Promise<void>((resolve) => {
    server.close((error) => {
      closeError = error;
      resolve();
    });
  });

  try {
    await stopNoteScheduler();
    await stopAuthMailWorker();
    await shutdownCollaborationServer();
    await httpClosed;
    disconnectCache();
    await mongoose.disconnect();
  } catch (error) {
    closeError = error instanceof Error ? error : new Error(String(error));
    console.error("Graceful shutdown failed", error);
  } finally {
    clearTimeout(forceExit);
    process.exit(closeError ? 1 : 0);
  }
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

mongoose
  .connect(env.MONGO_CONN, {
    dbName: env.MONGO_DB_NAME,
    maxPoolSize: 20,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10_000,
  })
  .then(async () => {
    // Unique indexes must exist before concurrent first-session/preference writes.
    await Promise.all([DeviceSession.init(), Workspace.init(), Note.init(), Daily.init(), NoteSchedule.init(), PrivacyRequest.init(), AuthAction.init(), AuthMail.init(), User.init(), UserAuth.init(), Attachment.init(), AttachmentQuota.init()]);
    void connectCache();
    startNoteScheduler();
    startAuthMailWorker();
    server.listen(env.PORT, env.HOST, () => {
      console.log(`Server listening on ${env.HOST}:${env.PORT}`);
    });
  })
  .catch(async (error) => {
    console.error("Database startup failed", error);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
