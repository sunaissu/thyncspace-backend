import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { ClientSession } from "mongoose";
import nodemailer from "nodemailer";
import env from "../util/validateEnv.js";
import AuthMail from "../models/authMail.model.js";
import AuthAction from "../models/authAction.model.js";
import User from "../models/user.model.js";
import UserAuth from "../models/userAuth.model.js";

const key = createHmac("sha256", env.SESSION_SECRET).update("auth-mail-encryption-v1").digest();
export const emailKey = (email: string) => createHmac("sha256", key).update(email).digest("hex");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const seal = (value: unknown) => {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
};
const unseal = (value: string): { email: string; userId?: string; token?: string } => {
  const bytes = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
};
export const mailConfigured = () => Boolean(env.SMTP_HOST && env.MAIL_FROM);
export async function queueAuthMail(kind: "reset" | "verify" | "changed", email: string, userId?: string, session?: ClientSession) {
  const now = new Date(), identity = emailKey(email);
  const dedupe = kind === "changed" ? randomBytes(24).toString("hex") : `${kind}:${identity}:${Math.floor(now.getTime() / 300000)}`;
  try {
    await AuthMail.updateOne({ dedupe }, { $setOnInsert: { emailKey: identity, kind, payload: seal({ email, userId }), availableAt: now, expiresAt: new Date(now.getTime() + 30 * 60000) } }, { upsert: true, session }).exec();
  } catch (error) {
    if (session || !(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
  }
}

export type AuthMailSender = (mail: { to: string; subject: string; text: string }) => Promise<unknown>;
const send: AuthMailSender = async mail => {
  const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, requireTLS: !env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  try { await transport.sendMail({ ...mail, from: { name: "ThyncSpace", address: env.MAIL_FROM }, to: { name: "", address: mail.to } }); }
  finally { transport.close(); }
};

const finish = (id: unknown) => AuthMail.updateOne({ _id: id }, { $set: { attempts: 4 }, $unset: { payload: 1 } }).exec();

export async function runAuthMailQueue(sender: AuthMailSender = send, now = new Date()) {
  for (let index = 0; index < 20; index++) {
    const job = await AuthMail.findOneAndUpdate({ availableAt: { $lte: now }, leaseUntil: { $lte: now }, expiresAt: { $gt: now }, attempts: { $lt: 4 } }, { $set: { leaseUntil: new Date(now.getTime() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { availableAt: 1 } }).select("+payload").exec();
    if (!job) break;
    try {
      const payload = unseal(job.payload);
      const user = await User.findOne({ email: payload.email, suspendedAt: null }).select("+email").exec();
      const auth = user ? await UserAuth.findOne({ userId: user._id }).exec() : null;
      if (!user || !auth || (job.kind !== "verify" && auth.authProvider !== "local") || (payload.userId && payload.userId !== user.id) || (job.kind === "verify" && user.emailVerifiedAt)) {
        await finish(job._id); continue;
      }
      if (job.kind !== "changed") {
        if (!payload.token) {
          payload.token = randomBytes(32).toString("hex");
          await AuthAction.create({ userId: user._id, email: user.email, purpose: job.kind, tokenHash: tokenHash(payload.token), credentialVersion: user.credentialVersion ?? 0, expiresAt: job.expiresAt });
          await AuthMail.updateOne({ _id: job._id }, { $set: { payload: seal(payload) } }).exec();
        } else if (!await AuthAction.exists({ tokenHash: tokenHash(payload.token), expiresAt: { $gt: now } })) {
          await finish(job._id); continue;
        }
        const url = new URL("/account-action/", env.CLIENT_URL);
        url.hash = new URLSearchParams({ purpose: job.kind, token: payload.token }).toString();
        await sender({ to: user.email, subject: job.kind === "reset" ? "Reset your ThyncSpace password" : "Verify your ThyncSpace email", text: `${job.kind === "reset" ? "Choose a new password" : "Verify your email"} using this single-use link:\n\n${url}\n\nExpires at ${job.expiresAt.toISOString()}. If you did not request it, ignore this email. Your password is unchanged until you confirm.` });
      } else await sender({ to: user.email, subject: "Your ThyncSpace password changed", text: "Your password was changed and existing sessions were signed out. If you did not make this change, use password recovery on the ThyncSpace sign-in page and review your account access." });
      await finish(job._id);
    } catch {
      // Provider errors can contain addresses or message bodies. Never log them.
      console.error("Authentication email delivery failed; the queue will retry within its attempt limit.");
      await AuthMail.updateOne({ _id: job._id }, { $set: { availableAt: new Date(now.getTime() + 60000 * job.attempts), leaseUntil: new Date(0) } }).exec();
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined;
export const startAuthMailWorker = () => {
  if (timer || !mailConfigured()) return;
  const tick = () => { if (!running) running = runAuthMailQueue().catch(() => { console.error("Authentication mail queue unavailable."); }).finally(() => { running = undefined; }); };
  timer = setInterval(tick, 15000); timer.unref(); tick();
};
export const stopAuthMailWorker = async () => { if (timer) clearInterval(timer); timer = undefined; await running; };
