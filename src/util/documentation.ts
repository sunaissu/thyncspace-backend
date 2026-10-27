import * as Y from "yjs";
import { parseDocumentationContent, type DocumentationContent } from "./validation.js";

const SECTIONS_KEY = "documentation-sections";
const ORDER_KEY = "documentation-order";

const orderedIds = (order: unknown[], keys: Iterable<string>) => {
  if (!order.every(id => typeof id === "string")) throw new Error("Invalid documentation order");
  return [...new Set([...(order as string[]), ...[...keys].sort()])];
};

/** Materialize live sections only; deleted section stores remain available for undo. */
export function documentationContentFromDocument(document: Y.Doc): DocumentationContent {
  const metadata = document.getMap<Y.Map<unknown>>(SECTIONS_KEY);
  const sections: unknown[] = [];
  for (const id of orderedIds(document.getArray(ORDER_KEY).toArray(), metadata.keys())) {
    const entry = metadata.get(id);
    if (entry === undefined) continue;
    if (!(entry instanceof Y.Map)) throw new Error("Invalid documentation section");
    const type = entry.get("type"), title = entry.get("title");
    if (type === "text") {
      sections.push({ id, type, title, content: document.getText(`documentation-text:${id}`).toString() });
    } else if (type === "board") {
      const elementStore = document.getMap<Y.Map<unknown>>(`documentation-elements:${id}`);
      const orderStore = document.getArray(`documentation-order:${id}`);
      const viewport = document.getMap(`documentation-viewport:${id}`);
      const elements: Record<string, unknown>[] = [];
      for (const elementId of orderedIds(orderStore.toArray(), elementStore.keys())) {
        const element = elementStore.get(elementId);
        if (element === undefined) continue;
        if (!(element instanceof Y.Map) || element.get("id") !== elementId) throw new Error("Invalid documentation board element");
        elements.push(element.toJSON());
      }
      sections.push({ id, type, title, caption: entry.get("caption"), height: entry.get("height"), elements,
        viewport: { panX: viewport.get("panX") ?? 0, panY: viewport.get("panY") ?? 0, zoom: viewport.get("zoom") ?? 1 } });
    } else {
      throw new Error("Invalid documentation section type");
    }
  }
  const content = parseDocumentationContent({ format: "thyncspace-documentation", version: 1, sections });
  if (!content) throw new Error("Invalid documentation content or note is too large");
  return content;
}

/** Used for initial load and authoritative private/history replacement. */
export function replaceDocumentationContent(document: Y.Doc, value: unknown): void {
  const content = parseDocumentationContent(value ?? "");
  if (!content) throw new Error("Stored documentation content is invalid; restore a valid snapshot before editing");
  const metadata = document.getMap<Y.Map<unknown>>(SECTIONS_KEY);
  const order = document.getArray<string>(ORDER_KEY);
  metadata.clear();
  if (order.length) order.delete(0, order.length);
  for (const section of content.sections) {
    const entry = new Y.Map<unknown>();
    entry.set("type", section.type);
    entry.set("title", section.title);
    metadata.set(section.id, entry);
    if (section.type === "text") {
      const text = document.getText(`documentation-text:${section.id}`);
      if (text.length) text.delete(0, text.length);
      if (section.content) text.insert(0, section.content);
    } else {
      entry.set("caption", section.caption);
      entry.set("height", section.height);
      const elements = document.getMap<Y.Map<unknown>>(`documentation-elements:${section.id}`);
      const elementOrder = document.getArray<string>(`documentation-order:${section.id}`);
      const viewport = document.getMap<number>(`documentation-viewport:${section.id}`);
      elements.clear();
      if (elementOrder.length) elementOrder.delete(0, elementOrder.length);
      viewport.clear();
      for (const element of section.elements) {
        const fields = new Y.Map<unknown>();
        for (const [key, field] of Object.entries(element)) {
          fields.set(key, key === "text" && typeof field === "string" ? new Y.Text(field) : field);
        }
        elements.set(element.id as string, fields);
      }
      if (section.elements.length) elementOrder.insert(0, section.elements.map(element => element.id as string));
      for (const [key, field] of Object.entries(section.viewport)) viewport.set(key, field);
    }
  }
  if (content.sections.length) order.insert(0, content.sections.map(section => section.id));
}
