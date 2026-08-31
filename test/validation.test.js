import assert from "node:assert/strict";
import test from "node:test";
import {
  getShareIdentifierLookupQueries,
  parseWhiteboardContent,
  validateNoteContentForType,
} from "../dist/util/validation.js";
import { NoteType } from "../dist/types/_enums.js";

const validBoard = JSON.stringify({
  elements: [
    {
      height: 40,
      id: "shape-1",
      type: "rectangle",
      width: 80,
      x: 10,
      y: 20,
      seed: 1_999_999_999,
    },
    {
      height: 20,
      id: "line-1",
      points: [{ x: 0, y: 0 }, { x: 30, y: 20 }],
      type: "line",
      width: 30,
      x: 5,
      y: 5,
    },
  ],
  viewport: { panX: 12, panY: -8, zoom: 1.5 },
});

test("accepts a structurally valid whiteboard", () => {
  assert.equal(validateNoteContentForType(validBoard, NoteType.Whiteboard), validBoard);
  assert.deepEqual(parseWhiteboardContent(validBoard)?.viewport, {
    panX: 12,
    panY: -8,
    zoom: 1.5,
  });
});

test("accepts an explicit empty whiteboard", () => {
  assert.deepEqual(parseWhiteboardContent(""), {
    elements: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
  });
});

for (const [name, content] of [
  ["malformed JSON", "{"],
  ["missing elements", JSON.stringify({ viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["invalid viewport", JSON.stringify({ elements: [], viewport: { panX: 0, panY: 0, zoom: 0 } })],
  ["unknown element", JSON.stringify({ elements: [{ id: "x", type: "future" }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["duplicate IDs", JSON.stringify({ elements: [JSON.parse(validBoard).elements[0], JSON.parse(validBoard).elements[0]], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["unsafe coordinate", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[0], x: 1e100 }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["out-of-range zoom", JSON.stringify({ elements: [], viewport: { panX: 0, panY: 0, zoom: 6 } })],
  ["external image source", JSON.stringify({ elements: [{ height: 10, id: "image-1", type: "image", width: 10, x: 0, y: 0, dataUrl: "https://example.com/image.png" }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["overlong element ID", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[0], id: "x".repeat(257) }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["non-finite optional style number", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[0], angle: 1e400 }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["absurd font size", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[0], fontSize: 100_000 }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["invalid stroke style", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[0], strokeStyle: "surprise" }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["partial drop shadow", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[0], dropShadow: { color: "#000" } }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["invalid pen pressure", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[1], points: [{ x: 0, y: 0, pressure: 2 }] }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
  ["invalid connector binding", JSON.stringify({ elements: [{ ...JSON.parse(validBoard).elements[1], startBinding: { elementId: "shape-1", fixedPoint: { x: "left", y: 0 } } }], viewport: { panX: 0, panY: 0, zoom: 1 } })],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => validateNoteContentForType(content, NoteType.Whiteboard),
      (error) => error?.status === 400,
    );
  });
}

test("rejects overlong inline element text", () => {
  const board = {
    elements: [
      {
        ...JSON.parse(validBoard).elements[0],
        text: "x".repeat(1_000_001),
      },
    ],
    viewport: { panX: 0, panY: 0, zoom: 1 },
  };
  assert.equal(parseWhiteboardContent(board), undefined);
});

test("document content remains plain text", () => {
  assert.equal(validateNoteContentForType("not JSON", NoteType.Document), "not JSON");
});

test("email-looking share identifiers prefer normalized email", () => {
  assert.deepEqual(getShareIdentifierLookupQueries("  Person@Example.COM  "), [
    { email: "person@example.com" },
    { username: "Person@Example.COM" },
  ]);
});

test("non-email share identifiers only query normalized username", () => {
  assert.deepEqual(getShareIdentifierLookupQueries("  Example   User  "), [
    { username: "Example User" },
  ]);
});
