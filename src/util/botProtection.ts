import createHttpError from "http-errors";
import env from "./validateEnv.js";
let active = 0;
export const authPolicy = () => ({ registrationEnabled: env.REGISTRATION_ENABLED, turnstileSiteKey: env.TURNSTILE_SITE_KEY });
export const assertRegistrationEnabled = () => { if (!env.REGISTRATION_ENABLED) throw createHttpError(503, "New registrations are temporarily closed. Existing accounts can still sign in."); };
export async function verifyBotToken(token: unknown, action: "register" | "login" | "recover", transport: typeof fetch = fetch) {
  if (!env.TURNSTILE_SECRET_KEY) return;
  if (typeof token !== "string" || !token || token.length > 2048) throw createHttpError(400, "Complete the verification challenge before submitting.");
  if (active >= 10) throw createHttpError(503, "Verification is busy. Try again shortly.");
  active++;
  try {
    const response = await transport("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }) });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader(); let text = "", bytes = 0; const decoder = new TextDecoder();
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 8192) throw new Error(); text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const result = JSON.parse(text);
    if (result?.success !== true || result.hostname !== new URL(env.CLIENT_URL).hostname || result.action !== action) throw createHttpError(400, "Verification expired or failed. Complete a new challenge.");
  } catch (error) {
    if (createHttpError.isHttpError(error) && error.status === 400) throw error;
    throw createHttpError(503, "Verification is unavailable. Try again shortly.");
  } finally { active--; }
}
