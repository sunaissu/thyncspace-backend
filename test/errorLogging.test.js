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
    message: "Operation failed; private diagnostics omitted",
    code: "EACCES",
  });
});

test("summarizeError does not stringify unknown thrown values", () => {
  assert.deepEqual(summarizeError({ secret: "must-not-be-logged" }), {
    name: "UnknownError",
    message: "A non-Error value was thrown",
  });
});

test("summaries exclude secrets in top-level names, messages, codes and nested database diagnostics", () => {
 const error = Object.assign(new Error("password=private-note-title"), { name: "private-owner-name", code: "PRIVATE_TOKEN", status: 502, query: { content: "private-note-body" } });
 assert.deepEqual(summarizeError(error), { name: "Error", message: "Operation failed; private diagnostics omitted", status: 502 });
 assert.equal(summarizeError(Object.assign(new Error("duplicate secret"), { code: 11000 })).code, 11000);
});
