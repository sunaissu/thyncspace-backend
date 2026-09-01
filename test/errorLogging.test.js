import assert from "node:assert/strict";
import test from "node:test";
import { summarizeError } from "../dist/util/errorLogging.js";

test("summarizeError omits nested provider response details", () => {
  const error = Object.assign(new Error("Failed to obtain access token"), {
    code: "EACCES",
    oauthError: { access_token: "must-not-be-logged" },
  });

  assert.deepEqual(summarizeError(error), {
    name: "Error",
    message: "Failed to obtain access token",
    code: "EACCES",
  });
});

test("summarizeError does not stringify unknown thrown values", () => {
  assert.deepEqual(summarizeError({ secret: "must-not-be-logged" }), {
    name: "UnknownError",
    message: "A non-Error value was thrown",
  });
});
