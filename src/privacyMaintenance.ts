import "dotenv/config";
import mongoose from "mongoose";
import env from "./util/validateEnv.js";
import PrivacyRequest from "./models/privacyRequest.model.js";
import User from "./models/user.model.js";
import { fulfillDeletionRequest } from "./services/accountDeletion.js";
import { connectCache, disconnectCache, cacheKeys, deleteCachedKeys } from "./util/cache.js";

const [command, requestId, username, stopped] = process.argv.slice(2);
try {
  if (command !== "list" && !(command === "fulfill" && requestId && username && stopped === "--service-stopped")) throw new Error('Usage: node dist/privacyMaintenance.js list | fulfill REQUEST_ID "EXACT_USERNAME" --service-stopped');
  await mongoose.connect(env.MONGO_CONN, { dbName: env.MONGO_DB_NAME });
  if (command === "list") {
    const requests = PrivacyRequest.find({ status: "pending" }).sort({ requestedAt: 1 }).cursor();
    try { for await (const request of requests) {
      const user = await User.findById(request.owner).select("username").lean().exec();
      console.log(JSON.stringify({ id: request.id, username: user?.username, requestedAt: request.requestedAt }));
    } } finally { await requests.close(); }
  } else {
    const result = await fulfillDeletionRequest(requestId, username);
    await connectCache();
    await deleteCachedKeys(cacheKeys.sessionUser(result.owner), cacheKeys.ownedNotes(result.owner), ...result.affectedOwners.map(cacheKeys.ownedNotes));
    console.log("Deletion request fulfilled. Revocation tombstones expire with their sessions.");
  }
} catch (error) { console.error(error instanceof Error ? error.message : "Privacy maintenance failed"); process.exitCode = 1; }
finally { disconnectCache(); await mongoose.disconnect(); }
