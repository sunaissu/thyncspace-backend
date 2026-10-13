import createHttpError from "http-errors";

export type LinkedSelection = ({ kind: "lines"; start: number; end: number; revision: number } | { kind: "elements"; ids: string[]; revision: number }) & { needsReview?: true };
export function validateLinkedSelection(value: unknown): LinkedSelection | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw createHttpError(400, "Invalid linked selection");
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0) throw createHttpError(400, "Invalid selection revision");
  const revision = Number(item.revision), review = item.needsReview === true ? { needsReview: true as const } : {};
  if (item.kind === "lines" && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && Number(item.start) >= 1 && Number(item.end) >= Number(item.start) && Number(item.end) <= 1_048_577 && Number(item.end) - Number(item.start) < 1000) return { kind: "lines", start: Number(item.start), end: Number(item.end), revision, ...review };
  if (item.kind === "elements" && Array.isArray(item.ids) && item.ids.length > 0 && item.ids.length <= 200 && item.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && !Array.from(id).some(char => char.charCodeAt(0) < 32)) && new Set(item.ids).size === item.ids.length) return { kind: "elements", ids: item.ids as string[], revision, ...review };
  throw createHttpError(400, "Choose up to 1,000 lines or 200 board objects");
}
export function validateSelectionSource(selection: LinkedSelection | null, source: { type?: string | null; content?: string | null; contentRevision: number }) {
  if (!selection) return;
  if (selection.needsReview || selection.revision !== source.contentRevision) throw createHttpError(409, "The source changed. Refresh before selecting its content");
  if (selection.kind === "lines") {
    if (source.type !== "document" || selection.end > (source.content ?? "").split("\n").length) throw createHttpError(400, "Choose lines in the current document");
  } else {
    let elements: Array<{ id?: unknown; isDeleted?: unknown }> = [];
    try { const value = JSON.parse(source.content ?? ""); if (Array.isArray(value.elements)) elements = value.elements; } catch { /* Invalid board content cannot be selected. */ }
    const ids = new Set(elements.filter(item => item && !item.isDeleted).map(item => item.id));
    if (source.type !== "whiteboard" || selection.ids.some(id => !ids.has(id))) throw createHttpError(400, "Choose objects in the current board");
  }
}
