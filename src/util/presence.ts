export interface PresencePosition {
  surface: "board" | "visual" | "markdown" | "preview";
  x: number;
  y: number;
  block?: number;
}

export function parsePresence(value: unknown): PresencePosition | null {
  if (!value || typeof value !== "object") return null;
  const p = value as PresencePosition;
  if (!["board", "visual", "markdown", "preview"].includes(p.surface) ||
      !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e7 || Math.abs(p.y) > 1e7) return null;
  if (p.surface !== "board" && (p.x < 0 || p.x > 1 || !Number.isSafeInteger(p.block) || p.block! < 0 || p.block! > 100000)) return null;
  return { surface: p.surface, x: p.x, y: p.y, ...(p.surface === "board" ? {} : { block: p.block }) };
}
