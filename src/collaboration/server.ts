import { Hocuspocus } from "@hocuspocus/server";
import type { Server as HttpServer } from "http";
import mongoose from "mongoose";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import NoteModel from "../models/note.model.js";
import UserModel from "../models/user.model.js";
import { NoteStatus, NoteType, PermissionLevel } from "../types/_enums.js";
import { verifyCollaborationToken } from "../util/collaborationToken.js";
import { invalidateOwnedNotesCache } from "../util/cache.js";
import env from "../util/validateEnv.js";
import {
  MAX_NOTE_CONTENT_BYTES,
  validateNoteTitle,
} from "../util/validation.js";

interface CollaborationContext {
  expiresAt: number;
  lastAccessCheck: number;
  permission: PermissionLevel;
  privateOnly?: boolean;
  userId: string;
  username: string;
}

const ELEMENTS_KEY = "noteboard-elements";
const ORDER_KEY = "noteboard-order";
const TEXT_KEY = "document-content";
const TITLE_KEY = "note-title";
const VIEWPORT_KEY = "noteboard-viewport";
const CLIENT_ORIGIN = new URL(env.CLIENT_URL).origin;
const ACCESS_RECHECK_INTERVAL_MS = 60_000;
const COLLABORATION_TOKEN_SWEEP_MS = 60_000;
const MAX_COLLABORATION_STATE_BYTES = 8 * 1024 * 1024;
const MAX_UPGRADES_PER_MINUTE = 60;
const MAX_TRACKED_UPGRADE_ADDRESSES = 10_000;

interface UpgradeWindow {
  count: number;
  resetAt: number;
}

const upgradeWindows = new Map<string, UpgradeWindow>();

const emptyBoard = () => ({
  elements: [] as Array<Record<string, unknown>>,
  viewport: { panX: 0, panY: 0, zoom: 1 } as Record<string, number>,
});

const parseBoard = (content: unknown) => {
  let parsed = content;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return emptyBoard();
    }
  }
  if (typeof parsed !== "object" || parsed === null) return emptyBoard();

  const value = parsed as Record<string, unknown>;
  const elements = Array.isArray(value.elements)
    ? value.elements.filter(
        (element): element is Record<string, unknown> =>
          typeof element === "object" && element !== null,
      )
    : [];
  const viewport =
    typeof value.viewport === "object" && value.viewport !== null
      ? (value.viewport as Record<string, number>)
      : emptyBoard().viewport;
  return {
    elements,
    viewport,
  };
};

const seedDocument = (
  document: Y.Doc,
  title: string,
  type: NoteType,
  content: unknown,
) => {
  if (title) document.getText(TITLE_KEY).insert(0, title);
  if (type === NoteType.Document) {
    const value = typeof content === "string" ? content : "";
    if (value) document.getText(TEXT_KEY).insert(0, value);
    return;
  }

  const board = parseBoard(content);
  const elementStore = document.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
  const orderStore = document.getArray<string>(ORDER_KEY);
  const elements = Array.isArray(board.elements) ? board.elements : [];
  elements.forEach((element) => {
    if (typeof element.id !== "string") return;
    const value = new Y.Map<unknown>();
    Object.entries(element).forEach(([key, field]) => {
      if (field !== undefined) value.set(key, field);
    });
    elementStore.set(element.id, value);
  });
  const order = elements
    .map((element) => element.id)
    .filter((id): id is string => typeof id === "string");
  if (order.length) orderStore.insert(0, order);

  const viewport = document.getMap<number>(VIEWPORT_KEY);
  Object.entries(board.viewport ?? {}).forEach(([key, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) viewport.set(key, value);
  });
};

const replaceText = (text: Y.Text, value: string) => {
  if (text.toString() === value) return;
  if (text.length) text.delete(0, text.length);
  if (value) text.insert(0, value);
};

const replaceBoard = (document: Y.Doc, content: string) => {
  const board = parseBoard(content);
  const elementStore = document.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
  const orderStore = document.getArray<string>(ORDER_KEY);
  const viewportStore = document.getMap<number>(VIEWPORT_KEY);

  elementStore.clear();
  if (orderStore.length) orderStore.delete(0, orderStore.length);
  viewportStore.clear();

  board.elements.forEach((element) => {
    if (typeof element.id !== "string") return;
    const value = new Y.Map<unknown>();
    Object.entries(element).forEach(([key, field]) => {
      if (field !== undefined) value.set(key, field);
    });
    elementStore.set(element.id, value);
  });
  const order = board.elements
    .map((element) => element.id)
    .filter((id): id is string => typeof id === "string");
  if (order.length) orderStore.insert(0, order);
  Object.entries(board.viewport).forEach(([key, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      viewportStore.set(key, value);
    }
  });
};

const boardContentFromDocument = (document: Y.Doc) => {
  const elementStore = document.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
  const orderStore = document.getArray<string>(ORDER_KEY);
  const viewportStore = document.getMap<number>(VIEWPORT_KEY);
  const included = new Set<string>();
  const elements: Record<string, unknown>[] = [];
  const append = (id: string) => {
    const element = elementStore.get(id);
    if (!element || included.has(id)) return;
    elements.push(element.toJSON());
    included.add(id);
  };
  orderStore.toArray().forEach(append);
  elementStore.forEach((_value, id) => append(id));

  const viewport = {
    panX: viewportStore.get("panX") ?? 0,
    panY: viewportStore.get("panY") ?? 0,
    zoom: viewportStore.get("zoom") ?? 1,
  };
  return JSON.stringify({
    version: 1,
    elements,
    viewport,
    savedAt: new Date().toISOString(),
  });
};

const getAccess = async (documentName: string, userId: string) => {
  if (!mongoose.isValidObjectId(documentName)) throw new Error("Invalid note ID");
  const note = await NoteModel.findOne({
    _id: documentName,
    status: NoteStatus.Active,
  })
    .select("owner sharedWith type")
    .exec();
  if (!note) throw new Error("Note not found");
  if (note.owner.toString() === userId) {
    return { note, permission: PermissionLevel.Editor };
  }
  const collaborator = note.sharedWith.find(
    (entry) => entry.userId.toString() === userId,
  );
  if (!collaborator) throw new Error("Not authorized for this note");
  return { note, permission: collaborator.permission as PermissionLevel };
};

export const collaborationServer = new Hocuspocus<CollaborationContext>({
  name: "thyncspace-collaboration",
  debounce: 2500,
  maxDebounce: 10000,
  async onAuthenticate({ documentName, token, connectionConfig }) {
    const payload = verifyCollaborationToken(token);
    if (payload.noteId !== documentName) throw new Error("Token note mismatch");
    const { permission } = await getAccess(documentName, payload.userId);
    const user = await UserModel.findById(payload.userId).select("username").exec();
    if (!user) throw new Error("User not found");
    connectionConfig.readOnly = permission !== PermissionLevel.Editor;
    return {
      expiresAt: payload.expiresAt,
      lastAccessCheck: Date.now(),
      permission,
      userId: payload.userId,
      username: user.username,
    };
  },
  async onTokenSync({ context, documentName, token, connection }) {
    const payload = verifyCollaborationToken(token);
    if (payload.noteId !== documentName) throw new Error("Token note mismatch");
    if (payload.userId !== context.userId) throw new Error("Token user mismatch");
    const { permission } = await getAccess(documentName, payload.userId);
    connection.readOnly = permission !== PermissionLevel.Editor;
    context.expiresAt = payload.expiresAt;
    context.lastAccessCheck = Date.now();
    context.permission = permission;
  },
  async beforeSync({ context, documentName, connection }) {
    if (context.expiresAt <= Date.now()) {
      throw new Error("Collaboration token expired");
    }
    if (Date.now() - context.lastAccessCheck >= ACCESS_RECHECK_INTERVAL_MS) {
      const { permission } = await getAccess(documentName, context.userId);
      context.lastAccessCheck = Date.now();
      context.permission = permission;
      connection.readOnly = permission !== PermissionLevel.Editor;
    }
  },
  async beforeHandleAwareness({ context, states }) {
    if (!context) return;
    states.forEach((state) => {
      state.user = {
        id: context.userId,
        name: context.username,
        color: state.user?.color,
      };
    });
  },
  async onLoadDocument({ documentName }) {
    const note = await NoteModel.findOne({
      _id: documentName,
      status: NoteStatus.Active,
    })
      .select("+collaborationState content title type")
      .exec();
    if (!note) throw new Error("Note not found");
    const document = new Y.Doc();
    if (note.collaborationState?.length) {
      Y.applyUpdate(document, new Uint8Array(note.collaborationState));
      if (!document.getText(TITLE_KEY).length) {
        document.getText(TITLE_KEY).insert(0, note.title);
      }
    } else {
      seedDocument(document, note.title, note.type as NoteType, note.content);
    }
    return document;
  },
  async onStoreDocument({ documentName, document, lastContext }) {
    const privateOnly = lastContext?.privateOnly === true;
    const noteFilter = {
      _id: documentName,
      status: NoteStatus.Active,
      ...(privateOnly
        ? { owner: lastContext.userId, "sharedWith.0": { $exists: false } }
        : {}),
    };
    const note = await NoteModel.findOne(noteFilter)
      .select("owner title type")
      .exec();
    if (!note) return;
    const encodedState = Buffer.from(Y.encodeStateAsUpdate(document));
    if (encodedState.length > MAX_COLLABORATION_STATE_BYTES) {
      throw new Error("Collaboration document is too large to store safely");
    }
    const content = note.type === NoteType.Document
      ? document.getText(TEXT_KEY).toString()
      : boardContentFromDocument(document);
    if (Buffer.byteLength(content, "utf8") > MAX_NOTE_CONTENT_BYTES) {
      throw new Error("Note content is too large to store safely");
    }
    const sharedTitle = document.getText(TITLE_KEY).toString();
    const title = sharedTitle ? validateNoteTitle(sharedTitle) : note.title;
    await NoteModel.updateOne(
      noteFilter,
      { collaborationState: encodedState, content, title },
    ).exec();
    await invalidateOwnedNotesCache(note.owner.toString());
  },
});

export const updateNoteState = async (
  noteId: string,
  ownerId: string,
  type: NoteType,
  changes: { content?: string; title?: string },
  privateOnly: boolean,
) => {
  const connection = await collaborationServer.openDirectConnection(noteId, {
    expiresAt: Number.MAX_SAFE_INTEGER,
    lastAccessCheck: Date.now(),
    permission: PermissionLevel.Editor,
    privateOnly,
    userId: ownerId,
    username: "Private owner",
  });
  try {
    await connection.transact((document) => {
      if (changes.title !== undefined) {
        replaceText(document.getText(TITLE_KEY), changes.title);
      }
      if (changes.content === undefined) return;
      if (type === NoteType.Document) {
        replaceText(document.getText(TEXT_KEY), changes.content);
      } else {
        replaceBoard(document, changes.content);
      }
    });
  } finally {
    await connection.disconnect();
  }
};

export const updateCollaboratorPermission = (
  noteId: string,
  userId: string,
  permission: PermissionLevel,
) => {
  collaborationServer.documents.get(noteId)?.getConnections().forEach((connection) => {
    const context = connection.context as CollaborationContext;
    if (context.userId !== userId) return;
    context.lastAccessCheck = Date.now();
    context.permission = permission;
    connection.readOnly = permission !== PermissionLevel.Editor;
  });
};

export const disconnectCollaborator = (noteId: string, userId: string) => {
  collaborationServer.documents.get(noteId)?.getConnections().forEach((connection) => {
    const context = connection.context as CollaborationContext;
    if (context.userId === userId) connection.close();
  });
};

export const disconnectNote = (noteId: string) => {
  collaborationServer.documents
    .get(noteId)
    ?.getConnections()
    .forEach((connection) => connection.close());
};

const revalidateActiveConnections = async () => {
  const tasks: Promise<void>[] = [];
  collaborationServer.documents.forEach((document, noteId) => {
    tasks.push((async () => {
      try {
        const note = await NoteModel.findOne({
          _id: noteId,
          status: NoteStatus.Active,
        })
          .select("owner sharedWith")
          .exec();
        document.getConnections().forEach((connection) => {
          const context = connection.context as CollaborationContext | undefined;
          if (!context || context.expiresAt <= Date.now() || !note) {
            connection.close();
            return;
          }
          const permission =
            note.owner.toString() === context.userId
              ? PermissionLevel.Editor
              : note.sharedWith.find(
                  (entry) => entry.userId.toString() === context.userId,
                )?.permission;
          if (!permission) {
            connection.close();
            return;
          }
          context.lastAccessCheck = Date.now();
          context.permission = permission as PermissionLevel;
          connection.readOnly = permission !== PermissionLevel.Editor;
        });
      } catch (error) {
        console.error(`Could not recheck collaboration access for ${noteId}`, error);
      }
    })());
  });
  await Promise.all(tasks);
};

const requestAddress = (request: import("http").IncomingMessage) => {
  const directAddress = request.socket.remoteAddress ?? "unknown";
  const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    directAddress,
  );
  if (!isLoopback) return directAddress;

  const cloudflareAddress = request.headers["cf-connecting-ip"];
  if (typeof cloudflareAddress === "string" && cloudflareAddress) {
    return cloudflareAddress;
  }
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",", 1)[0].trim();
  }
  return directAddress;
};

const upgradeAllowed = (address: string) => {
  const now = Date.now();
  const window = upgradeWindows.get(address);
  if (!window || window.resetAt <= now) {
    if (upgradeWindows.size >= MAX_TRACKED_UPGRADE_ADDRESSES) {
      upgradeWindows.forEach((candidate, key) => {
        if (candidate.resetAt <= now) upgradeWindows.delete(key);
      });
      if (upgradeWindows.size >= MAX_TRACKED_UPGRADE_ADDRESSES) return false;
    }
    upgradeWindows.set(address, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  window.count += 1;
  return window.count <= MAX_UPGRADES_PER_MINUTE;
};

const rejectUpgrade = (
  socket: import("stream").Duplex,
  status: number,
  message: string,
) => {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
};

export const attachCollaborationServer = (server: HttpServer) => {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/collaboration") {
      socket.destroy();
      return;
    }
    if (request.headers.origin !== CLIENT_ORIGIN) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!upgradeAllowed(requestAddress(request))) {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
        else if (value !== undefined) headers.set(key, value);
      });
      const webRequest = new Request(
        `https://thyncspace-api.invalid${request.url ?? "/collaboration"}`,
        { headers },
      );
      const clientConnection = collaborationServer.handleConnection(
        websocket,
        webRequest,
      );

      websocket.on("message", (data) => {
        const message = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : data;
        clientConnection.handleMessage(message);
      });
      websocket.on("close", (code, reason) => {
        clientConnection.handleClose({
          code,
          reason: reason.toString("utf8"),
        });
      });
      websocket.on("error", (error) => {
        console.error("Collaboration WebSocket error", error);
      });
    });
  });

  let sweepRunning = false;
  const sweepTimer = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void revalidateActiveConnections()
      .catch((error) => {
        console.error("Collaboration access recheck failed", error);
      })
      .finally(() => {
        sweepRunning = false;
      });
  }, COLLABORATION_TOKEN_SWEEP_MS);
  sweepTimer.unref();
  server.once("close", () => clearInterval(sweepTimer));
};
