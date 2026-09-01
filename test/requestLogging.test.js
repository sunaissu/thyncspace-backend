import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRequestTarget } from "../dist/util/requestLogging.js";

test("sanitizeRequestTarget removes OAuth callback query parameters", () => {
  assert.equal(
    sanitizeRequestTarget(
      "/api/auth/google/callback?code=authorization-code&state=state-value",
    ),
    "/api/auth/google/callback",
  );
});

test("sanitizeRequestTarget preserves safe request paths", () => {
  assert.equal(sanitizeRequestTarget("/readyz"), "/readyz");
  assert.equal(sanitizeRequestTarget("/search%3Fterm"), "/search%3Fterm");
  assert.equal(sanitizeRequestTarget(), "/");
});
