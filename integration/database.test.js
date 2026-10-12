import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Always use disposable local storage; never read the application's .env.
Object.assign(process.env, {
 CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters',
 GOOGLE_AUTH_CLIENT_ID: 'test-client', GOOGLE_AUTH_CLIENT_SECRET: 'test-secret',
 GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://127.0.0.1:1',
 MONGO_DB_NAME: 'disposable_review', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
});
const { default: mongoose } = await import('mongoose');
const { default: Note } = await import('../dist/models/note.model.js');
const notes = await import('../dist/controller/notes.js');
const library = await import('../dist/controller/noteLibrary.js');
const { collaborationServer, shutdownCollaborationServer } = await import('../dist/collaboration/server.js');
const owner = new mongoose.Types.ObjectId().toString();
const stranger = new mongoose.Types.ObjectId().toString();
async function invoke(handler, { noteId, versionId, body = {}, userId = owner } = {}) {
 const result = {};
 const response = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; }, sendStatus(code) { result.status = code; return this; } };
 await handler({ user: { id: userId }, params: { noteId, versionId }, body }, response, error => { result.error = error; });
 return result;
}

test('real replica-set import, concurrent saves, history, trash and recovery', { timeout: 180000 }, async t => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
 try {
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_review' });
  let noteId;
  await t.test('bulk import returns the committed notes in input order', async () => {
   const imported = await invoke(notes.importNotes, { body: { notes: [{ title: 'First', text: 'base' }, { title: 'Second', text: '' }] } });
   assert.ifError(imported.error); assert.equal(imported.status, 201);
   assert.deepEqual(imported.body.map(n => n.title), ['First', 'Second']);
   noteId = imported.body[0]._id.toString();
   assert.equal(await Note.countDocuments({ owner }), 2);
  });
  await t.test('only one concurrent save based on the same revision succeeds', async () => {
   const results = await Promise.all(['left', 'right'].map(text => invoke(notes.updatePrivateNote, { noteId, body: { text, expectedRevision: 0 } })));
   assert.equal(results.filter(r => r.status === 200).length, 1);
   assert.equal(results.filter(r => r.error?.status === 409).length, 1);
   const stored = await Note.findById(noteId).select('+history');
   assert.equal(stored.contentRevision, 1); assert.equal(stored.history.length, 1);
   assert.equal(stored.history[0].content, 'base');
   assert.equal((await invoke(notes.updatePrivateNote, { noteId, body: { text: 'missing revision' } })).error?.status, 428);
   assert.equal((await invoke(notes.updatePrivateNote, { noteId, userId: stranger, body: { text: 'attack', expectedRevision: 1 } })).error?.status, 403);
  });
  await t.test('history is bounded and restoring a revision creates a private copy', async () => {
   for (let i = 1; i <= 7; i++) assert.ifError((await invoke(notes.updatePrivateNote, { noteId, body: { text: 'revision ' + i, expectedRevision: i } })).error);
   const stored = await Note.findById(noteId).select('+history');
   assert.equal(stored.history.length, 5);
   const result = await invoke(library.recoverNote, { noteId, body: { versionId: stored.history[0]._id.toString() } });
   assert.ifError(result.error); assert.notEqual(result.body._id.toString(), noteId);
   assert.equal(result.body.content, stored.history[0].content);
   assert.equal(await Note.countDocuments({ _id: noteId }), 1);
  });
  await t.test('version content and names stay owner-only', async () => {
   const source = await Note.findById(noteId).select('+history');
   const versionId = source.history[0]._id.toString();
   assert.equal((await invoke(library.getVersion, { noteId, versionId, userId: stranger })).error?.status, 404);
   assert.equal((await invoke(library.renameVersion, { noteId, versionId, userId: stranger, body: { label: 'attack' } })).error?.status, 404);
   assert.ifError((await invoke(library.renameVersion, { noteId, versionId, body: { label: 'Checkpoint' } })).error);
   const result = await invoke(library.getVersion, { noteId, versionId });
   assert.equal(result.body.label, 'Checkpoint'); assert.equal(result.body.content, source.history[0].content);
   assert.equal((await invoke(library.renameVersion, { noteId, versionId, body: { label: { $ne: '' } } })).error?.status, 400);
  });
  await t.test('permanent deletion requires confirmation, ownership and a trashed note', async () => {
   const source = await Note.create({ owner, title: 'Permanent', type: 'document', status: 'trashed', content: 'temporary' });
   assert.equal((await invoke(library.permanentlyDeleteTrash, { noteId: source.id })).error?.status, 400);
   assert.equal((await invoke(library.permanentlyDeleteTrash, { noteId: source.id, userId: stranger, body: { confirmation: source.id } })).error?.status, 404);
   assert.equal((await invoke(library.permanentlyDeleteTrash, { noteId, body: { confirmation: noteId } })).error?.status, 404);
   assert.equal((await invoke(library.permanentlyDeleteTrash, { noteId: source.id, body: { confirmation: source.id } })).status, 204);
   assert.equal(await Note.findById(source.id), null);
  });
  await t.test('failed trash consumption rolls back the newly created copy', async () => {
   const source = await Note.create({ owner, title: 'Rollback', type: 'document', content: 'keep', status: 'trashed' });
   const before = await Note.countDocuments({ owner });
   const remove = Note.deleteOne;
   try {
    Note.deleteOne = () => ({ exec: async () => { throw new Error('injected delete failure'); } });
    assert.match((await invoke(library.recoverNote, { noteId: source.id })).error.message, /injected/);
   } finally { Note.deleteOne = remove; }
   assert.equal(await Note.countDocuments({ owner }), before);
   assert.ok(await Note.findById(source.id));
  });
  await t.test('first sharing rejects stale snapshots and REST cannot replace shared content', async () => {
   const { default: User } = await import('../dist/models/user.model.js');
   const peer = await User.create({ username: 'Integration peer', email: 'peer@example.test' });
   const source = await Note.create({ owner, title: 'Handoff', content: 'newer', type: 'document', contentRevision: 1 });
   const body = { identifier: peer.username, permission: 'editor', snapshot: { text: 'stale', expectedRevision: 0 } };
   assert.equal((await invoke(notes.shareNote, { noteId: source.id, body })).error?.status, 409);
   assert.equal((await Note.findById(source.id)).sharedWith.length, 0);
   body.snapshot = { text: 'latest local edit', expectedRevision: 1 };
   assert.ifError((await invoke(notes.shareNote, { noteId: source.id, body })).error);
   const stored = await Note.findById(source.id);
   assert.equal(stored.content, 'latest local edit'); assert.equal(stored.sharedWith.length, 1);
   assert.equal((await invoke(notes.updateNote, { noteId: source.id, body: { text: 'overwrite', expectedRevision: stored.contentRevision } })).error?.status, 409);
  });
  await t.test('trash recovery is owner-only and consumes its tombstone exactly once', async () => {
   assert.equal((await invoke(notes.deleteNote, { noteId })).status, 204);
   assert.equal((await invoke(library.recoverNote, { noteId, userId: stranger })).error?.status, 404);
   const results = await Promise.all([invoke(library.recoverNote, { noteId }), invoke(library.recoverNote, { noteId })]);
   assert.equal(results.filter(r => r.status === 201).length, 1);
   assert.equal(results.filter(r => r.error?.status === 404).length, 1);
   const restored = results.find(r => r.status === 201).body;
   assert.notEqual(restored._id.toString(), noteId); assert.deepEqual(restored.sharedWith, []);
   assert.equal(await Note.countDocuments({ _id: noteId }), 0);
  });
 } finally {
  await shutdownCollaborationServer();
  await collaborationServer.hooks("onDestroy", {});
  await mongoose.disconnect(); await replica.stop();
 }
});
