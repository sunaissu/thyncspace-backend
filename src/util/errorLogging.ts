interface ErrorLogDetails { name: string; message: string; code?: string | number; status?: number }
const names = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ValidationError", "CastError", "VersionError", "MongoServerError", "MongoNetworkError", "MongoServerSelectionError", "AbortError", "TimeoutError"]);
const codes = new Set(["EACCES", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ESOCKET", "ENETUNREACH"]);
// Provider and database messages can contain credentials, queries or note text.
export const summarizeError = (error: unknown): ErrorLogDetails => {
  if (!(error instanceof Error)) return { name: "UnknownError", message: "A non-Error value was thrown" };
  const details: ErrorLogDetails = { name: names.has(error.name) ? error.name : "Error", message: "Operation failed; private diagnostics omitted" };
  const candidate = error as Error & { code?: unknown; status?: unknown };
  if (typeof candidate.code === "number" && Number.isSafeInteger(candidate.code) && candidate.code >= 0 && candidate.code <= 1000000 || typeof candidate.code === "string" && codes.has(candidate.code)) details.code = candidate.code as string | number;
  if (typeof candidate.status === "number" && Number.isInteger(candidate.status) && candidate.status >= 400 && candidate.status <= 599) details.status = candidate.status;
  return details;
};
