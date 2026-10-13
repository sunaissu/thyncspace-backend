import { activityEntry, activityPush } from "../util/noteActivity.js";
import { parsePresence } from "../util/presence.js";
import { assertActiveDeviceSession } from "../util/deviceSessions.js";
import DeviceSession from "../models/deviceSession.model.js";
import { collaborationSnapshot } from "../util/collaborationSnapshot.js";
import { createHash } from "node:crypto";
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
  parseWhiteboardContent,
  validateNoteTitle,
} from "../util/validation.js";

interface DurableStoreAttempt {
  error?: Error;
  status: "failed" | "pending" | "succeeded";
}

interface CollaborationContext {
  sessionHash?: string;
  durableStoreAttempt?: DurableStoreAttempt;
  expiresAt: number;
  lastAccessCheck: number;
  permission: PermissionLevel;
  noteType?: NoteType;
  privateOnly?: boolean;
  userId: string;
  username: string;
  presenceClientId?: number;
  presenceColor?: string;
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

// Hocuspocus deliberately catches errors from onStoreDocument so it can keep
// the in-memory document alive. Keep the latest failed store per document as a
// separate durability signal for shutdown; a later successful store clears it.
const collaborationStoreFailures = new Map<string, Error>();

const normalizeError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

interface UpgradeWindow {
  count: number;
  resetAt: number;
}

const upgradeWindows = new Map<string, UpgradeWindow>();

const parseBoard = (content: unknown) => {
  const validated = parseWhiteboardContent(content ?? "");
  if (validated) return validated;

  throw new Error("Stored whiteboard content is invalid; restore a valid snapshot before editing");
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
    await assertActiveDeviceSession(payload.sessionHash, payload.userId);
    const { permission, note } = await getAccess(documentName, payload.userId);
    const user = await UserModel.findById(payload.userId).select("username").exec();
    if (!user) throw new Error("User not found");
    connectionConfig.readOnly = permission !== PermissionLevel.Editor;
    return {
      noteType: note.type,
      expiresAt: payload.expiresAt,
      lastAccessCheck: Date.now(),
      permission,
      userId: payload.userId,
      sessionHash: payload.sessionHash,
      username: user.username,
    };
  },
  async onTokenSync({ context, documentName, token, connection }) {
    const payload = verifyCollaborationToken(token);
    if (payload.noteId !== documentName) throw new Error("Token note mismatch");
    if (payload.userId !== context.userId) throw new Error("Token user mismatch");
    if (payload.sessionHash !== context.sessionHash) throw new Error("Token session mismatch");
    await assertActiveDeviceSession(payload.sessionHash, payload.userId);
    const { permission, note } = await getAccess(documentName, payload.userId);
    connection.readOnly = permission !== PermissionLevel.Editor;
    context.noteType = note.type;
    context.expiresAt = payload.expiresAt;
    context.lastAccessCheck = Date.now();
    context.permission = permission;
  },
  async beforeSync({ context, documentName, connection, document, type, payload }) {
    if (context.sessionHash) await assertActiveDeviceSession(context.sessionHash, context.userId);
    if (context.expiresAt <= Date.now()) {
      throw new Error("Collaboration token expired");
    }
    if (Date.now() - context.lastAccessCheck >= ACCESS_RECHECK_INTERVAL_MS) {
      const { permission } = await getAccess(documentName, context.userId);
      context.lastAccessCheck = Date.now();
      context.permission = permission;
      connection.readOnly = permission !== PermissionLevel.Editor;
    }
    if ((type === 1 || type === 2) && !connection.readOnly) {
      if (!context.noteType) throw new Error("Unknown note type");
      validateCollaborationUpdate(document, payload, context.noteType);
    }
  },
  async beforeHandleAwareness({ context, states, document, connection }) {
    if (!context || !connection) { states.clear(); return; }
    if (context.expiresAt <= Date.now()) throw new Error("Collaboration token expired");
    // Scratch awareness also contains its own empty state; never publish it.
    for (const [id, state] of states) if (!state.user) states.delete(id);
    if (states.size > 1) throw new Error("A connection may publish only its own cursor");
    for (const [id, state] of states) {
      if (!Number.isSafeInteger(id) || id < 0 || (context.presenceClientId !== undefined && context.presenceClientId !== id)) throw new Error("Cursor session mismatch");
      const others = document.getConnections().filter(peer => peer !== connection);
      if (others.some(peer => peer.context?.presenceClientId === id)) throw new Error("Cursor session is already owned");
      context.presenceClientId = id;
      if (!context.presenceColor) {
        const used = new Set(others.map(peer => peer.context?.presenceColor));
        const colors = ["#2563eb", "#b91c1c", "#047857", "#7e22ce", "#c2410c", "#0e7490", "#be185d", "#4d7c0f"];
        let color = colors.find(value => !used.has(value));
        let offset = 0;
        while (!color) { const candidate = "#" + createHash("sha256").update(context.userId + ":" + id + ":" + offset++).digest("hex").slice(0, 6); if (!used.has(candidate)) color = candidate; }
        context.presenceColor = color;
        connection.sendStateless(JSON.stringify({ type: "presence-identity", id: context.userId, name: context.username.slice(0, 80), color, clientId: id }));
      }
      states.set(id, {
        user: { id: context.userId, name: context.username.slice(0, 80), color: context.presenceColor },
        cursor: parsePresence(state.cursor),
      });
    }
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
    const durableStoreAttempt = lastContext?.durableStoreAttempt;
    try {
      const privateOnly = lastContext?.privateOnly === true;
      const noteFilter = {
        _id: documentName,
        status: NoteStatus.Active,
        ...(privateOnly
          ? { owner: lastContext.userId, "sharedWith.0": { $exists: false } }
          : {}),
      };
      const note = await NoteModel.findOne(noteFilter)
        .select("owner title type content updatedAt")
        .exec();
      if (!note) {
        if (durableStoreAttempt) {
          throw new Error(
            privateOnly
              ? "The private note changed before its collaboration state could be stored"
              : "The note is no longer available for collaboration storage",
          );
        }

        // A deleted note can still receive a final WebSocket close event. There
        // is intentionally nothing to persist in that case.
        collaborationStoreFailures.delete(documentName);
        return;
      }
      const encodedState = Buffer.from(Y.encodeStateAsUpdate(document));
      const storedFingerprint = createHash("sha256").update(collaborationSnapshot(document, note.type)).digest("hex");
      if (encodedState.length > MAX_COLLABORATION_STATE_BYTES) {
        throw new Error("Collaboration document is too large to store safely");
      }
      const content = note.type === NoteType.Document
        ? document.getText(TEXT_KEY).toString()
        : boardContentFromDocument(document);
      if (Buffer.byteLength(content, "utf8") > MAX_NOTE_CONTENT_BYTES) {
        throw new Error("Note content is too large to store safely");
      }
      if (
        note.type === NoteType.Whiteboard &&
        parseWhiteboardContent(content) === undefined
      ) {
        throw new Error("Whiteboard content is invalid and was not stored");
      }
      const sharedTitle = document.getText(TITLE_KEY).toString();
      const title = sharedTitle ? validateNoteTitle(sharedTitle) : note.title;
      const sameContent = note.type === NoteType.Document
        ? note.content === content
        : JSON.stringify(parseWhiteboardContent(note.content)) === JSON.stringify(parseWhiteboardContent(content));
      const result = await NoteModel.updateOne(
        noteFilter,
        {
          $set: { collaborationState: encodedState, content, title },
          ...(!sameContent ? { $inc: { contentRevision: 1 } } : {}),
          ...(!sameContent || note.title !== title ? {
            $push: { activity: activityPush(activityEntry("edit", privateOnly ? lastContext?.userId : undefined)), history: { $each: [{ title: note.title, content: note.content ?? "", savedAt: note.updatedAt ?? new Date() }], $slice: -5 } },
          } : {}),
        },
      ).exec();
      if (result.matchedCount !== 1) {
        throw new Error(
          "The note changed before its collaboration state could be stored",
        );
      }
      await invalidateOwnedNotesCache(note.owner.toString());

      document.broadcastStateless?.(JSON.stringify({ type: "stored", version: 1, fingerprint: storedFingerprint }));
      collaborationStoreFailures.delete(documentName);
      if (durableStoreAttempt) {
        durableStoreAttempt.error = undefined;
        durableStoreAttempt.status = "succeeded";
      }
    } catch (error) {
      const storeError = normalizeError(error);
      collaborationStoreFailures.set(documentName, storeError);
      document.broadcastStateless?.(JSON.stringify({ type: "store-error", version: 1 }));
      if (durableStoreAttempt) {
        durableStoreAttempt.error = storeError;
        durableStoreAttempt.status = "failed";
      }
      throw error;
    }
  },
});

export const updateNoteState = async (
  noteId: string,
  ownerId: string,
  type: NoteType,
  changes: { content?: string; title?: string },
  privateOnly: boolean,
) => {
  const durableStoreAttempt: DurableStoreAttempt = { status: "pending" };
  const connection = await collaborationServer.openDirectConnection(noteId, {
    durableStoreAttempt,
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

  if (durableStoreAttempt.status === "failed") {
    const storeError =
      durableStoreAttempt.error ?? new Error("Could not store note state");
    // A failed direct-only document is unloaded after disconnect and its error
    // has already been returned to the caller. Retain the global failure only
    // when a live document remains and shutdown still needs to account for it.
    if (!collaborationServer.documents.has(noteId)) {
      collaborationStoreFailures.delete(noteId);
    }
    throw storeError;
  }
  if (durableStoreAttempt.status !== "succeeded") {
    throw new Error("The collaboration store did not report a durable result");
  }
};

export const refreshPresenceIdentity = (userId: string, username: string) => {
  collaborationServer.documents.forEach(document => document.getConnections().forEach(connection => {
    const context = connection.context;
    if (context.userId !== userId) return;
    context.username = username;
    if (context.presenceClientId !== undefined) connection.sendStateless(JSON.stringify({ type: "presence-identity", id: userId, name: username.slice(0, 80), color: context.presenceColor, clientId: context.presenceClientId }));
  }));
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

export const disconnectUserSessions = (userId: string) => {
  collaborationServer.documents.forEach(document => document.getConnections().forEach(connection => {
    if (connection.context.userId === userId) connection.close();
  }));
};

export const disconnectDeviceSession = (sessionHash: string) => {
  collaborationServer.documents.forEach(document => document.getConnections().forEach(connection => {
    if (connection.context.sessionHash === sessionHash) connection.close();
  }));
};

/** Close live editors and wait for every pending collaboration save to finish. */
export const shutdownCollaborationServer = async () => {
  collaborationServer.closeConnections();

  // Let WebSocket close handlers enqueue their final immediate stores.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const documents = [...collaborationServer.documents.values()];
  const executions: Promise<unknown>[] = [];
  for (const document of documents) {
    const debounceId = `onStoreDocument-${document.name}`;
    if (collaborationServer.debouncer.isDebounced(debounceId)) {
      executions.push(
        Promise.resolve(collaborationServer.debouncer.executeNow(debounceId)),
      );
    }
  }
  await Promise.all(executions);

  // A store may already have started before executeNow. A no-op mutex task is
  // a barrier that resolves only after that database write releases the lock.
  await Promise.all(
    documents.map((document) =>
      document.saveMutex.runExclusive(async () => undefined),
    ),
  );

  // A final close-triggered store can fail immediately before Hocuspocus
  // unloads its document. Those failures are intentionally retained in this
  // map even when the document is no longer present, so account for all of
  // them rather than only the still-loaded snapshot above.
  const failures = [...collaborationStoreFailures].map(
    ([documentName, error]) => ({ documentName, error }),
  );
  if (failures.length) {
    failures.forEach(({ documentName, error }) => {
      console.error(`Collaboration state for ${documentName} was not stored`, error);
    });
    throw new Error(
      `Could not safely store ${failures.length} collaboration document${
        failures.length === 1 ? "" : "s"
      } during shutdown`,
    );
  }
};

const revalidateActiveConnections = async () => {
  const sessionHashes = [...new Set([...collaborationServer.documents.values()].flatMap(document => document.getConnections().map(connection => connection.context.sessionHash).filter((value): value is string => Boolean(value))))];
  let activeSessions: Set<string>;
  try {
    const devices = await DeviceSession.find({ sessionHash: { $in: sessionHashes }, revokedAt: null, expiresAt: { $gt: new Date() } }).select("+sessionHash").exec();
    const users = await UserModel.find({ _id: { $in: devices.map(device => device.userId) } }).select("credentialVersion").exec();
    const versions = new Map(users.map(user => [user.id, user.credentialVersion ?? 0]));
    activeSessions = new Set(devices.filter(device => versions.get(String(device.userId)) === (device.credentialVersion ?? 0)).map(device => device.sessionHash));
  } catch {
    // Fail closed when revocation state cannot be verified.
    collaborationServer.closeConnections();
    return;
  }
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
          if (!context || context.expiresAt <= Date.now() || !note || (context.sessionHash && !activeSessions.has(context.sessionHash))) {
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
    let url: URL;
    try {
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new Error("Invalid upgrade target");
      url = new URL(request.url, "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
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

/** Persist live edits before moving a note out of the active collection. */
export const flushNoteState = async (noteId: string) => {
  const document = collaborationServer.documents.get(noteId);
  if (!document) return;
  await collaborationServer.storeDocumentHooks(document, {
    clientsCount: document.getConnectionsCount(), document, documentName: noteId,
    instance: collaborationServer, lastContext: undefined,
    lastTransactionOrigin: { source: "local" },
  }, true);
  const failure = collaborationStoreFailures.get(noteId);
  if (failure) throw failure;
};

/** Validate on an isolated replica before an editor can poison live shared state. */
export const validateCollaborationUpdate = (document: Y.Doc, update: Uint8Array, type: NoteType) => {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(candidate, update);
    if (Y.encodeStateAsUpdate(candidate).byteLength > MAX_COLLABORATION_STATE_BYTES) throw new Error("Collaboration document is too large");
    const title = candidate.getText(TITLE_KEY).toString();
    if (title) validateNoteTitle(title);
    const content = type === NoteType.Document ? candidate.getText(TEXT_KEY).toString() : boardContentFromDocument(candidate);
    if (Buffer.byteLength(content, "utf8") > MAX_NOTE_CONTENT_BYTES) throw new Error("Note content is too large");
    if (type === NoteType.Whiteboard && !parseWhiteboardContent(content)) throw new Error("Invalid whiteboard update");
  } finally { candidate.destroy(); }
};
