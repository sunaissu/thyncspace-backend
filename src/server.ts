import { createServer } from "http";
import mongoose from "mongoose";
import app from "./app";
import { attachCollaborationServer } from "./collaboration/server";
import env from "./util/validateEnv";

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

  server.close(async (error) => {
    try {
      await mongoose.disconnect();
    } finally {
      clearTimeout(forceExit);
      process.exit(error ? 1 : 0);
    }
  });
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
  .then(() => {
    server.listen(env.PORT, env.HOST, () => {
      console.log(`Server listening on ${env.HOST}:${env.PORT}`);
    });
  })
  .catch((error) => {
    console.error("MongoDB connection failed", error);
    process.exitCode = 1;
  });
