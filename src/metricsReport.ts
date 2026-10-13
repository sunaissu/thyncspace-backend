import mongoose from "mongoose";
import env from "./util/validateEnv.js";
import { aggregateMetrics } from "./services/productMetrics.js";
import { summarizeError } from "./util/errorLogging.js";
try {
  await mongoose.connect(env.MONGO_CONN, { dbName: env.MONGO_DB_NAME, serverSelectionTimeoutMS: 10000 });
  console.log(JSON.stringify(await aggregateMetrics(), null, 2));
} catch (error) { console.error("Could not read aggregate usage counts", summarizeError(error)); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
