import createHttpError from "http-errors";
import { NoteType } from "../types/_enums.js";

export const MAX_NOTE_TITLE_LENGTH = 200;
export const MAX_NOTE_CONTENT_BYTES = 1024 * 1024;
export const MAX_IMPORT_NOTES = 100;
export const MAX_IMPORT_CONTENT_BYTES = 4 * 1024 * 1024;

const EMAIL_PATTERN = /^[^\s@<>,;:"\\()[\]\p{Cc}]+@[^\s@]+\.[^\s@]+$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const MAX_ABSOLUTE_BOARD_COORDINATE = 1_000_000_000;
const MAX_BOARD_ELEMENTS = 10_000;
const MAX_ELEMENT_ID_LENGTH = 256;
const MAX_ELEMENT_POINTS = 100_000;
const MAX_ELEMENT_TEXT_LENGTH = 1_000_000;
const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;
const MAX_STYLE_STRING_LENGTH = 1024;
const MAX_ELEMENT_SEED = 2_147_483_647;
const FILL_STYLES = new Set(["solid", "hachure", "cross-hatch", "none"]);
const STROKE_STYLES = new Set(["solid", "dashed", "dotted"]);
const BLEND_MODES = new Set([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
]);
const CURVE_TYPES = new Set(["straight", "curve"]);
const ROUTING_MODES = new Set(["straight", "curve", "orthogonal"]);
const TEXT_ALIGNMENTS = new Set(["left", "center", "right"]);
const FONT_WEIGHTS = new Set(["normal", "bold"]);
const FONT_STYLES = new Set(["normal", "italic"]);
const TEXT_DECORATIONS = new Set(["none", "underline", "line-through"]);
const CALLOUT_DIRECTIONS = new Set([
  "bottom-left",
  "bottom-right",
  "top-left",
  "top-right",
]);
const ARROWHEADS = new Set(["arrow", "dot", "bar", "triangle"]);
const NOTEBOARD_ELEMENT_TYPES = new Set([
  "arrow",
  "callout",
  "diamond",
  "draw",
  "ellipse",
  "frame",
  "image",
  "line",
  "pen",
  "rectangle",
  "star",
  "sticky-note",
  "text",
  "triangle",
]);

export interface WhiteboardContent {
  elements: Array<Record<string, unknown>>;
  viewport: {
    panX: number;
    panY: number;
    zoom: number;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeCoordinate = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= MAX_ABSOLUTE_BOARD_COORDINATE;

const isFinitePoint = (value: unknown) =>
  isRecord(value) &&
  isSafeCoordinate(value.x) &&
  isSafeCoordinate(value.y) &&
  (value.pressure === undefined ||
    (typeof value.pressure === "number" &&
      Number.isFinite(value.pressure) &&
      value.pressure >= 0 &&
      value.pressure <= 1));

const isValidBinding = (value: unknown) =>
  value === undefined ||
  value === null ||
  (isRecord(value) &&
    typeof value.elementId === "string" &&
    value.elementId.length > 0 &&
    value.elementId.length <= MAX_ELEMENT_ID_LENGTH &&
    isFinitePoint(value.fixedPoint));

const hasValidOptionalNumber = (
  value: Record<string, unknown>,
  key: string,
  minimum = -MAX_ABSOLUTE_BOARD_COORDINATE,
  maximum = MAX_ABSOLUTE_BOARD_COORDINATE,
) => {
  const field = value[key];
  return (
    field === undefined ||
    (typeof field === "number" &&
      Number.isFinite(field) &&
      field >= minimum &&
      field <= maximum)
  );
};

const hasValidOptionalString = (
  value: Record<string, unknown>,
  key: string,
  allowNull = false,
) => {
  const field = value[key];
  return (
    field === undefined ||
    (allowNull && field === null) ||
    (typeof field === "string" && field.length <= MAX_STYLE_STRING_LENGTH)
  );
};

const hasValidOptionalEnum = (
  value: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  allowNull = false,
) => {
  const field = value[key];
  return (
    field === undefined ||
    (allowNull && field === null) ||
    (typeof field === "string" && allowed.has(field))
  );
};

const isValidWhiteboardElement = (
  value: unknown,
): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > MAX_ELEMENT_ID_LENGTH ||
    typeof value.type !== "string" ||
    !NOTEBOARD_ELEMENT_TYPES.has(value.type) ||
    !isSafeCoordinate(value.x) ||
    !isSafeCoordinate(value.y) ||
    !isSafeCoordinate(value.width) ||
    !isSafeCoordinate(value.height)
  ) {
    return false;
  }

  for (const key of ["angle", "baseline"]) {
    if (!hasValidOptionalNumber(value, key)) return false;
  }
  if (
    value.seed !== undefined &&
    (!Number.isSafeInteger(value.seed) ||
      (value.seed as number) < -MAX_ELEMENT_SEED ||
      (value.seed as number) > MAX_ELEMENT_SEED)
  ) {
    return false;
  }
  if (!hasValidOptionalNumber(value, "opacity", 0, 100)) return false;
  if (!hasValidOptionalNumber(value, "roughness", 0, 100)) return false;
  if (!hasValidOptionalNumber(value, "borderRadius", 0)) return false;
  if (!hasValidOptionalNumber(value, "strokeWidth", 0, 10_000)) return false;
  if (!hasValidOptionalNumber(value, "fontSize", 0.01, 10_000)) return false;
  if (!hasValidOptionalNumber(value, "labelFontSize", 0.01, 10_000)) return false;
  if (!hasValidOptionalNumber(value, "lineHeight", 0.01, 1_000)) return false;
  if (!hasValidOptionalNumber(value, "tension", 0, 1)) return false;
  if (!hasValidOptionalNumber(value, "innerRadius", 0, 1)) return false;
  if (
    value.sides !== undefined &&
    (!Number.isInteger(value.sides) || (value.sides as number) < 3 || (value.sides as number) > 12)
  ) {
    return false;
  }
  for (const key of ["highlighter", "isDeleted", "isStar", "locked", "showLabel"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  for (const key of [
    "backgroundColor",
    "fontFamily",
    "frameColor",
    "groupId",
    "highlightColor",
    "labelFontFamily",
    "noteColor",
    "strokeColor",
  ]) {
    if (!hasValidOptionalString(value, key)) return false;
  }
  if (!hasValidOptionalEnum(value, "fillStyle", FILL_STYLES)) return false;
  if (!hasValidOptionalEnum(value, "strokeStyle", STROKE_STYLES)) return false;
  if (!hasValidOptionalEnum(value, "blendMode", BLEND_MODES)) return false;
  if (!hasValidOptionalEnum(value, "curveType", CURVE_TYPES)) return false;
  if (!hasValidOptionalEnum(value, "routing", ROUTING_MODES)) return false;
  if (!hasValidOptionalEnum(value, "textAlign", TEXT_ALIGNMENTS)) return false;
  if (!hasValidOptionalEnum(value, "fontWeight", FONT_WEIGHTS)) return false;
  if (!hasValidOptionalEnum(value, "fontStyle", FONT_STYLES)) return false;
  if (!hasValidOptionalEnum(value, "textDecoration", TEXT_DECORATIONS)) return false;
  if (!hasValidOptionalEnum(value, "tailDirection", CALLOUT_DIRECTIONS)) return false;
  if (!hasValidOptionalEnum(value, "startArrowhead", ARROWHEADS, true)) return false;
  if (!hasValidOptionalEnum(value, "endArrowhead", ARROWHEADS, true)) return false;
  if (!isValidBinding(value.startBinding) || !isValidBinding(value.endBinding)) {
    return false;
  }

  if (value.dropShadow !== undefined) {
    if (!isRecord(value.dropShadow)) return false;
    if (
      !isSafeCoordinate(value.dropShadow.blur) ||
      (value.dropShadow.blur as number) < 0 ||
      !isSafeCoordinate(value.dropShadow.offsetX) ||
      !isSafeCoordinate(value.dropShadow.offsetY) ||
      (value.dropShadow.spread !== undefined &&
        !isSafeCoordinate(value.dropShadow.spread)) ||
      typeof value.dropShadow.color !== "string" ||
      value.dropShadow.color.length > MAX_STYLE_STRING_LENGTH
    ) {
      return false;
    }
  }

  if (value.childIds !== undefined) {
    if (
      !Array.isArray(value.childIds) ||
      value.childIds.length > MAX_BOARD_ELEMENTS ||
      !value.childIds.every(
        (id) =>
          typeof id === "string" && id.length > 0 && id.length <= MAX_ELEMENT_ID_LENGTH,
      )
    ) {
      return false;
    }
  }

  if (["line", "arrow", "draw", "pen"].includes(value.type)) {
    if (
      !Array.isArray(value.points) ||
      value.points.length > MAX_ELEMENT_POINTS ||
      !value.points.every(isFinitePoint)
    ) {
      return false;
    }
  }
  if (
    value.text !== undefined &&
    (typeof value.text !== "string" || value.text.length > MAX_ELEMENT_TEXT_LENGTH)
  ) {
    return false;
  }
  if (value.type === "text" && typeof value.text !== "string") return false;
  if (
    value.label !== undefined &&
    (typeof value.label !== "string" || value.label.length > MAX_ELEMENT_TEXT_LENGTH)
  ) {
    return false;
  }
  if (
    value.type === "image" &&
    (typeof value.dataUrl !== "string" ||
      value.dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH ||
      !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value.dataUrl) ||
      value.dataUrl.slice(value.dataUrl.indexOf(",") + 1).length % 4 !== 0)
  ) {
    return false;
  }
  return true;
};

/**
 * Parses the persisted Noteboard shape without throwing. The collaboration
 * loader rejects invalid records without overwriting the stored snapshot.
 */
export const parseWhiteboardContent = (
  content: unknown,
): WhiteboardContent | undefined => {
  if (content === "") {
    return { elements: [], viewport: { panX: 0, panY: 0, zoom: 1 } };
  }

  let parsed = content;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.elements) ||
    parsed.elements.length > MAX_BOARD_ELEMENTS
  ) {
    return undefined;
  }
  if (!isRecord(parsed.viewport)) return undefined;

  const { panX, panY, zoom } = parsed.viewport;
  if (!isSafeCoordinate(panX) || !isSafeCoordinate(panY) || !Number.isFinite(zoom)) {
    return undefined;
  }
  if ((zoom as number) < 0.1 || (zoom as number) > 5) return undefined;

  const seenIds = new Set<string>();
  const elements: Array<Record<string, unknown>> = [];
  for (const element of parsed.elements) {
    if (!isValidWhiteboardElement(element) || seenIds.has(element.id as string)) {
      return undefined;
    }
    seenIds.add(element.id as string);
    elements.push(element);
  }

  return {
    elements,
    viewport: {
      panX: panX as number,
      panY: panY as number,
      zoom: zoom as number,
    },
  };
};

export const normalizeEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export const validateEmail = (value: unknown) => {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw createHttpError(400, "Enter a valid email address");
  }
  const [local, domain] = email.split("@");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..") || Buffer.byteLength(local, "utf8") > 64 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw createHttpError(400, "Enter a valid email address");
  return email;
};

export const normalizeUsername = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

export const validateUsername = (value: unknown) => {
  const username = normalizeUsername(value);
  if (
    username.length < 2 ||
    username.length > 50 ||
    CONTROL_CHARACTER_PATTERN.test(username)
  ) {
    throw createHttpError(
      400,
      "Username must be between 2 and 50 characters and contain no control characters",
    );
  }
  return username;
};

export const validateRegistrationPassword = (value: unknown) => {
  if (typeof value !== "string" || value.length < 12) {
    throw createHttpError(400, "Password must be at least 12 characters");
  }
  if (value.length > 128 || Buffer.byteLength(value, "utf8") > 72) {
    throw createHttpError(400, "Password is too long");
  }
  return value;
};

export const validateLoginPassword = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    Buffer.byteLength(value, "utf8") > 72
  ) {
    throw createHttpError(400, "Enter a valid password");
  }
  return value;
};

export const validateNoteTitle = (value: unknown) => {
  if (typeof value !== "string") {
    throw createHttpError(400, "Note title must be text");
  }
  const title = value.trim();
  if (!title || title.length > MAX_NOTE_TITLE_LENGTH) {
    throw createHttpError(
      400,
      `Note title must be between 1 and ${MAX_NOTE_TITLE_LENGTH} characters`,
    );
  }
  return title;
};

export const validateNoteContent = (value: unknown) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw createHttpError(400, "Note content must be text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_NOTE_CONTENT_BYTES) {
    throw createHttpError(413, "Note content is too large");
  }
  return value;
};

export const validateNoteContentForType = (value: unknown, type: NoteType) => {
  const content = validateNoteContent(value);
  if (
    content !== undefined &&
    type === NoteType.Whiteboard &&
    parseWhiteboardContent(content) === undefined
  ) {
    throw createHttpError(400, "Whiteboard content is invalid");
  }
  return content;
};

export const validateNoteType = (value: unknown) => {
  if (value === undefined) return NoteType.Document;
  if (!Object.values(NoteType).includes(value as NoteType)) {
    throw createHttpError(400, "Note type must be document or whiteboard");
  }
  return value as NoteType;
};

export const validateShareIdentifier = (value: unknown) => {
  if (typeof value !== "string") {
    throw createHttpError(400, "Username or email is required");
  }
  const identifier = value.trim();
  if (!identifier || identifier.length > 254 || CONTROL_CHARACTER_PATTERN.test(identifier)) {
    throw createHttpError(400, "Enter a valid username or email");
  }
  return identifier;
};

export const getShareIdentifierLookupQueries = (identifier: string) => {
  const usernameQuery = { username: normalizeUsername(identifier) };
  return identifier.includes("@")
    ? [{ email: normalizeEmail(identifier) }, usernameQuery]
    : [usernameQuery];
};

export const validateNoteOrganization = (value: unknown) => {
  if (!isRecord(value) || typeof value.notebook !== "string" || !Array.isArray(value.tags)) {
    throw createHttpError(400, "Provide a notebook and a list of tags");
  }
  const notebook = value.notebook.trim();
  if (notebook.length > 80 || CONTROL_CHARACTER_PATTERN.test(notebook) || value.tags.length > 20) {
    throw createHttpError(400, "Use a notebook up to 80 characters and at most 20 tags");
  }
  if (notebook && notebook.split("/").some(part => !part.trim() || part.trim() !== part || part === "." || part === "..")) throw createHttpError(400, "Separate notebook levels with / and give each level a name");
  const tags = value.tags.map((tag: unknown) => {
    if (typeof tag !== "string" || !tag.trim() || tag.trim().length > 40 || CONTROL_CHARACTER_PATTERN.test(tag)) {
      throw createHttpError(400, "Tags must contain 1 to 40 characters");
    }
    return tag.trim().toLowerCase();
  });
  if (value.isTemplate !== undefined && typeof value.isTemplate !== "boolean") throw createHttpError(400, "Template setting must be a boolean");
  if (value.isArchived !== undefined && typeof value.isArchived !== "boolean") throw createHttpError(400, "Archive setting must be a boolean");
  return { notebook, tags: [...new Set(tags)], ...(value.isTemplate === undefined ? {} : { isTemplate: value.isTemplate }), ...(value.isArchived === undefined ? {} : { isArchived: value.isArchived }) };
};

/** Imported paths are metadata, never filesystem destinations. */
export function validateSourcePath(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || input.length > 1024 || /[\p{Cc}]/u.test(input)) throw createHttpError(400, "Invalid source path");
  const path = input.split("\\").join("/");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw createHttpError(400, "Source path must be relative without traversal");
  return path;
}
