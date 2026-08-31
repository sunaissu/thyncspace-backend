import assert from "node:assert/strict";
import test from "node:test";

const requiredTestEnvironment = {
  CLIENT_URL: "http://localhost:3000",
  COLLABORATION_SECRET: "test-collaboration-secret-at-least-32-characters",
  GOOGLE_AUTH_CLIENT_ID: "test-client",
  GOOGLE_AUTH_CLIENT_SECRET: "test-secret",
  GOOGLE_CALLBACK_URL: "http://localhost:5000/auth/google/callback",
  MONGO_CONN: "mongodb://localhost:27017",
  MONGO_DB_NAME: "thyncspace_test",
  SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
};

Object.entries(requiredTestEnvironment).forEach(([name, value]) => {
  process.env[name] ??= value;
});

const { NoteType } = await import("../dist/types/_enums.js");
const { default: NoteModel } = await import("../dist/models/note.model.js");
const {
  collaborationServer,
  shutdownCollaborationServer,
  updateNoteState,
} = await import("../dist/collaboration/server.js");

test("direct updates and shutdown surface a swallowed collaboration store failure", async (t) => {
  const directNoteId = "64b000000000000000000001";
  const pendingNoteId = "64b000000000000000000003";
  const ownerId = "64b000000000000000000002";
  const originalFindOne = NoteModel.findOne;
  const originalUpdateOne = NoteModel.updateOne;
  const originalConsoleError = console.error;
  const storedError = new Error("simulated MongoDB store failure");
  let pendingConnection;

  const note = {
    collaborationState: undefined,
    content: "before",
    owner: { toString: () => ownerId },
    title: "Persistence test",
    type: NoteType.Document,
  };
  NoteModel.findOne = () => {
    const query = {
      exec: async () => note,
      select: () => query,
    };
    return query;
  };
  NoteModel.updateOne = () => ({
    exec: async () => {
      throw storedError;
    },
  });
  console.error = () => undefined;

  t.after(() => {
    NoteModel.findOne = originalFindOne;
    NoteModel.updateOne = originalUpdateOne;
    console.error = originalConsoleError;
    if (pendingConnection?.document) {
      pendingConnection.document.removeDirectConnection();
      pendingConnection.document = null;
    }
    for (const noteId of [directNoteId, pendingNoteId]) {
      const document = collaborationServer.documents.get(noteId);
      collaborationServer.documents.delete(noteId);
      document?.destroy();
    }
  });

  await assert.rejects(
    updateNoteState(
      directNoteId,
      ownerId,
      NoteType.Document,
      { content: "after" },
      false,
    ),
    (error) => error === storedError,
  );

  const pendingContext = {
    expiresAt: Number.MAX_SAFE_INTEGER,
    lastAccessCheck: Date.now(),
    permission: "editor",
    userId: ownerId,
    username: "Persistence test",
  };
  pendingConnection = await collaborationServer.openDirectConnection(
    pendingNoteId,
    pendingContext,
  );
  const pendingDocument = pendingConnection.document;
  assert.ok(pendingDocument);
  await collaborationServer.storeDocumentHooks(
    pendingDocument,
    {
      clientsCount: pendingDocument.getConnectionsCount(),
      document: pendingDocument,
      documentName: pendingNoteId,
      instance: collaborationServer,
      lastContext: pendingContext,
      lastTransactionOrigin: { context: pendingContext, source: "local" },
    },
    true,
  );

  // A failed last-connection store may be followed by document unloading.
  // Shutdown must retain and report that durability failure regardless.
  collaborationServer.documents.delete(pendingNoteId);
  pendingDocument.removeDirectConnection();
  pendingConnection.document = null;
  pendingDocument.destroy();

  await assert.rejects(
    shutdownCollaborationServer(),
    /Could not safely store 1 collaboration document during shutdown/,
  );
});
