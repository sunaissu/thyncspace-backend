import type * as Y from "yjs";

/** Canonical materialized state: independent of replica GC/undo retention. */
export function collaborationSnapshot(document: Y.Doc, type: string): string {
  const value = {
    title: document.getText("note-title").toString(),
    content: type === "whiteboard" ? {
      elements: document.getMap("noteboard-elements").toJSON(),
      order: document.getArray("noteboard-order").toArray(),
      viewport: document.getMap("noteboard-viewport").toJSON(),
    } : document.getText("document-content").toString(),
  };
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return item;
  });
}
