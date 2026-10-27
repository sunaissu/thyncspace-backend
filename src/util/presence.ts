export interface PresencePosition {
  surface: "board" | "visual" | "markdown" | "preview";
  x: number;
  y: number;
  block?: number;
}

export interface TextCaretPosition {
  surface: "visual" | "markdown";
  block: number;
  offset: number;
  /** A local empty visual block that is not present in the shared markdown yet. */
  empty?: true;
}

export function parseTextCaret(value: unknown): TextCaretPosition | null {
  if (!value || typeof value !== "object") return null;
  const p = value as TextCaretPosition;
  if (!["visual", "markdown"].includes(p.surface) ||
      !Number.isSafeInteger(p.block) || p.block < 0 || p.block > 100000 ||
      !Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > 1048576 ||
      (p.surface === "markdown" && p.block !== 0) ||
      (p.empty !== undefined && (p.empty !== true || p.surface !== "visual" || p.offset !== 0))) return null;
  return { surface: p.surface, block: p.block, offset: p.offset, ...(p.empty ? { empty: true } : {}) };
}

export function parsePresence(value: unknown): PresencePosition | null {
  if (!value || typeof value !== "object") return null;
  const p = value as PresencePosition;
  if (!["board", "visual", "markdown", "preview"].includes(p.surface) ||
      !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e7 || Math.abs(p.y) > 1e7) return null;
  if (p.surface !== "board" && (p.x < 0 || p.x > 1 || !Number.isSafeInteger(p.block) || p.block! < 0 || p.block! > 100000)) return null;
  return { surface: p.surface, x: p.x, y: p.y, ...(p.surface === "board" ? {} : { block: p.block }) };
}
