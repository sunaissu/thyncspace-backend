import assert from "node:assert/strict";
import test from "node:test";
import { parseTextCaret } from "../dist/util/presence.js";

test("text caret positions contain only bounded document coordinates", () => {
  assert.deepEqual(parseTextCaret({ surface: "visual", block: 4, offset: 15, user: "forged" }), { surface: "visual", block: 4, offset: 15 });
  assert.deepEqual(parseTextCaret({ surface: "markdown", block: 0, offset: 1048576 }), { surface: "markdown", block: 0, offset: 1048576 });
  assert.deepEqual(parseTextCaret({ surface: "visual", block: 100000, offset: 0, empty: true }), { surface: "visual", block: 100000, offset: 0, empty: true });
  for (const input of [
    null, [], "caret",
    { surface: "board", block: 0, offset: 0 },
    { surface: "preview", block: 0, offset: 0 },
    { surface: "visual", block: -1, offset: 0 },
    { surface: "visual", block: 0.5, offset: 0 },
    { surface: "visual", block: 100001, offset: 0 },
    { surface: "visual", block: 0, offset: -1 },
    { surface: "visual", block: 0, offset: NaN },
    { surface: "visual", block: 0, offset: Infinity },
    { surface: "visual", block: 0, offset: 1.5 },
    { surface: "visual", block: 0, offset: 1048577 },
    { surface: "markdown", block: 1, offset: 0 },
    { surface: "markdown", block: 0, offset: 0, empty: true },
    { surface: "visual", block: 0, offset: 1, empty: true },
    { surface: "visual", block: 0, offset: 0, empty: "yes" },
  ]) assert.equal(parseTextCaret(input), null, JSON.stringify(input));
});
