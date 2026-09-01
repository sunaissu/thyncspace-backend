interface ErrorLogDetails {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
}

export const summarizeError = (error: unknown): ErrorLogDetails => {
  if (!(error instanceof Error)) {
    return {
      name: "UnknownError",
      message: "A non-Error value was thrown",
    };
  }

  const details: ErrorLogDetails = {
    name: error.name,
    message: error.message,
  };
  const candidate = error as Error & { code?: unknown; status?: unknown };

  if (typeof candidate.code === "string" || typeof candidate.code === "number") {
    details.code = candidate.code;
  }
  if (typeof candidate.status === "number") details.status = candidate.status;

  return details;
};
