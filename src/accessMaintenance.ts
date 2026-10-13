import "dotenv/config";
import mongoose from "mongoose";
import env from "./util/validateEnv.js";
import User from "./models/user.model.js";
import { changeAccountAccess } from "./services/accountAccess.js";
import { connectCache, disconnectCache } from "./util/cache.js";
const [command, id, username, version, actor, reason, stopped, ...extra] = process.argv.slice(2);
try {
  if (!id || !/^[a-f0-9]{24}$/i.test(id) || extra.length || !(command === "show" && !username || ["suspend", "resume"].includes(command) && stopped === "--service-stopped" && /^\d+$/.test(version ?? ""))) throw new Error('Usage: node dist/accessMaintenance.js show ACCOUNT_ID | suspend/resume ACCOUNT_ID "EXACT_USERNAME" VERSION "OPERATOR" "REASON" --service-stopped');
  await mongoose.connect(env.MONGO_CONN, { dbName: env.MONGO_DB_NAME });
  if (command === "show") { const user = await User.findById(id).select("username credentialVersion +suspendedAt +accessHistory").lean().exec(); if (!user) throw new Error("Account not found"); console.log(JSON.stringify(user)); }
  else { await connectCache(); await changeAccountAccess(id, username, Number(version), command, actor, reason); console.log("Account access updated. Existing credentials were revoked; resume does not restart schedules."); }
} catch (error) { console.error(error instanceof Error ? error.message : "Account access maintenance failed"); process.exitCode = 1; }
finally { disconnectCache(); await mongoose.disconnect(); }
