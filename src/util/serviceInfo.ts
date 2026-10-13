import env from "./validateEnv.js";
import { APP_VERSION } from "./appVersion.js";
export const serviceInfo = (ready: boolean) => ({ status: ready ? env.SERVICE_STATUS : "degraded", notice: env.SERVICE_NOTICE, supportUrl: env.PUBLIC_SUPPORT_URL, privacyUrl: env.PUBLIC_PRIVACY_URL, termsUrl: env.PUBLIC_TERMS_URL, retention: env.PUBLIC_RETENTION_NOTICE, version: APP_VERSION, checkedAt: new Date().toISOString() });
