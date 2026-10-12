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

const Y = await import('yjs');
const { default: mongoose } = await import('mongoose');
const { default: NoteModel } = await import('../dist/models/note.model.js');
const { NoteType } = await import('../dist/types/_enums.js');
const { validateCollaborationUpdate, collaborationServer } = await import('../dist/collaboration/server.js');
const { validateNoteOrganization, parseWhiteboardContent } = await import('../dist/util/validation.js');
const { getTrash, getHistory, updateOrganization, recoverNote } = await import('../dist/controller/noteLibrary.js');
const { toNoteResponse } = await import('../dist/util/noteResponse.js');
const owner = '64b000000000000000000002';
const noteId = '64b000000000000000000001';
const invoke = async (handler, data = {}) => {
  const result = {};
  const response = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } };
  await handler({ user: { id: owner }, params: { noteId }, body: {}, ...data }, response, error => { result.error = error; });
  return result;
};
test('organization rejects operator objects, controls and excessive tags', () => {
  assert.deepEqual(validateNoteOrganization({ notebook: ' Work ', tags: ['Math', 'math'] }), { notebook: 'Work', tags: ['math'] });
  for (const input of [null, { notebook: { $ne: '' }, tags: [] }, { notebook: 'x', tags: Array(21).fill('a') }, { notebook: 'x', tags: ['bad\u0000'] }]) assert.throws(() => validateNoteOrganization(input));
});
test('raster admission rejects SVG, malformed base64 and arbitrary MIME types', () => {
  for (const dataUrl of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,!!!!', 'data:image/png;base64,abc', 'data:image/html;base64,AAAA']) {
    assert.equal(parseWhiteboardContent({ elements: [{ id: 'a', type: 'image', x: 0, y: 0, width: 10, height: 10, dataUrl }], viewport: { panX: 0, panY: 0, zoom: 1 } }), undefined);
  }
});
test('invalid live state is rejected without changing the authoritative document', () => {
  const document = new Y.Doc(); document.getText('document-content').insert(0, 'safe');
  const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
  peer.getText('document-content').insert(4, 'x'.repeat(1024 * 1024));
  assert.throws(() => validateCollaborationUpdate(document, Y.encodeStateAsUpdate(peer), NoteType.Document), /too large/);
  assert.equal(document.getText('document-content').toString(), 'safe');
  const malformed = new Y.Doc(); malformed.getMap('noteboard-elements').set('bad', 123);
  assert.throws(() => validateCollaborationUpdate(new Y.Doc(), Y.encodeStateAsUpdate(malformed), NoteType.Whiteboard));
  document.destroy(); peer.destroy(); malformed.destroy();
});
test('valid document updates and empty whiteboards pass admission', () => {
  const document = new Y.Doc(), peer = new Y.Doc(); peer.getText('document-content').insert(0, 'new');
  assert.doesNotThrow(() => validateCollaborationUpdate(document, Y.encodeStateAsUpdate(peer), NoteType.Document));
  assert.doesNotThrow(() => validateCollaborationUpdate(document, Y.encodeStateAsUpdate(new Y.Doc()), NoteType.Whiteboard));
  document.destroy(); peer.destroy();
});
test('library endpoints require authentication and use owner-scoped queries', async t => {
  for (const handler of [getTrash, getHistory, updateOrganization, recoverNote]) assert.equal((await invoke(handler, { user: undefined })).error?.status, 401);
  const original = NoteModel.findOne;
  t.after(() => { NoteModel.findOne = original; });
  const filters = [];
  NoteModel.findOne = filter => { filters.push(filter); const query = { select: () => query, exec: async () => null }; return query; };
  assert.equal((await invoke(getHistory)).error.status, 404);
  assert.equal((await invoke(recoverNote)).error.status, 404);
  assert.ok(filters.every(filter => filter.owner === owner && filter._id === noteId));
  assert.equal(filters[0].status, 'active'); assert.equal(filters[1].status, 'trashed');
});
test('note responses never reveal revision history or private organization to collaborators', () => {
  const note = new NoteModel({ title: 'A', owner, notebook: 'private', tags: ['private'], history: [{ title: 'Secret', content: 'secret', savedAt: new Date() }] });
  const response = toNoteResponse(note, '64b000000000000000000003');
  assert.equal(response.history, undefined); assert.equal(response.notebook, undefined); assert.equal(response.tags, undefined);
});
test('history capture is atomic with content and keeps at most five prior snapshots', async t => {
  const find = NoteModel.findOne, update = NoteModel.updateOne;
  t.after(() => { NoteModel.findOne = find; NoteModel.updateOne = update; });
  const note = { owner: { toString: () => owner }, title: 'Before', content: 'old', type: NoteType.Document };
  NoteModel.findOne = () => { const query = { select: () => query, exec: async () => note }; return query; };
  let mutation;
  NoteModel.updateOne = (_filter, data) => ({ exec: async () => { mutation = data; return { matchedCount: 1 }; } });
  const document = new Y.Doc(); document.getText('document-content').insert(0, 'new');
  await collaborationServer.configuration.onStoreDocument({ documentName: noteId, document });
  assert.equal(mutation.$set.content, 'new'); assert.equal(mutation.$push.history.$slice, -5);
  assert.equal(mutation.$push.history.$each[0].content, 'old'); document.destroy();
});
test('trash recovery creates a new private identity and consumes the source in one transaction', async t => {
  const original = { find: NoteModel.findOne, create: NoteModel.create, remove: NoteModel.deleteOne, session: mongoose.startSession };
  t.after(() => { NoteModel.findOne = original.find; NoteModel.create = original.create; NoteModel.deleteOne = original.remove; mongoose.startSession = original.session; });
  let created, deleted = false, transaction = false;
  const source = { title: 'Recovered', content: 'retained', type: NoteType.Document, notebook: 'Work', tags: ['math'], history: [] };
  NoteModel.findOne = filter => { const query = { select: () => query, exec: async () => filter._id === noteId ? source : created }; return query; };
  mongoose.startSession = async () => ({ withTransaction: async action => { transaction = true; await action(); return { ok: 1 }; }, endSession: async () => {} });
  NoteModel.create = async ([input]) => { assert.ok(transaction); assert.notEqual(input._id.toString(), noteId); created = new NoteModel(input); return [created]; };
  NoteModel.deleteOne = filter => ({ exec: async () => { assert.equal(filter.owner, owner); assert.equal(filter.status, 'trashed'); deleted = true; return { deletedCount: 1 }; } });
  const result = await invoke(recoverNote); assert.equal(result.error, undefined); assert.equal(result.status, 201); assert.ok(deleted);
  assert.deepEqual(result.body.sharedWith, []); assert.equal(result.body.content, 'retained');
});

test('malformed upgrade request targets cannot escape the request handler', async () => {
  const { EventEmitter } = await import('node:events');
  const { attachCollaborationServer } = await import('../dist/collaboration/server.js');
  const server = new EventEmitter(); attachCollaborationServer(server);
  for (const url of ['http://[', '//[', '']) {
    let response = '';
    const socket = { end: value => { response = value; }, destroy() {} };
    assert.doesNotThrow(() => server.emit('upgrade', { url, headers: {}, socket: {} }, socket, Buffer.alloc(0)));
    assert.match(response, /400 Bad Request/);
  }
  server.emit('close');
});

test('board serialization timestamps do not evict useful history', async t => {
  const find = NoteModel.findOne, update = NoteModel.updateOne;
  t.after(() => { NoteModel.findOne = find; NoteModel.updateOne = update; });
  const note = { owner: { toString: () => owner }, title: 'Board', content: JSON.stringify({ elements: [], viewport: { panX: 0, panY: 0, zoom: 1 }, savedAt: '2000-01-01' }), type: NoteType.Whiteboard };
  NoteModel.findOne = () => { const query = { select: () => query, exec: async () => note }; return query; };
  let mutation; NoteModel.updateOne = (_filter, data) => ({ exec: async () => { mutation = data; return { matchedCount: 1 }; } });
  const document = new Y.Doc();
  await collaborationServer.configuration.onStoreDocument({ documentName: noteId, document });
  assert.equal(mutation.$push, undefined); document.destroy();
});

test('invalid stored whiteboards fail closed rather than opening an empty board', async t => {
  const find = NoteModel.findOne;
  t.after(() => { NoteModel.findOne = find; });
  NoteModel.findOne = () => { const query = { select: () => query, exec: async () => ({ title: 'Legacy', type: NoteType.Whiteboard, content: '{bad json' }) }; return query; };
  await assert.rejects(collaborationServer.configuration.onLoadDocument({ documentName: noteId }), /Stored whiteboard content is invalid/);
});


test('durable receipts describe the persisted snapshot, including deletions, not later edits', async t => {
  const { createHash } = await import('node:crypto');
  const find = NoteModel.findOne, update = NoteModel.updateOne;
  t.after(() => { NoteModel.findOne = find; NoteModel.updateOne = update; });
  const document = new Y.Doc(); document.getText('document-content').insert(0, 'abc');
  const { collaborationSnapshot } = await import('../dist/util/collaborationSnapshot.js');
  const fingerprint = () => createHash('sha256').update(collaborationSnapshot(document, 'document')).digest('hex');
  const beforeDelete = fingerprint(); document.getText('document-content').delete(1, 1);
  const stored = fingerprint(); assert.notEqual(stored, beforeDelete);
  const receipts = []; document.broadcastStateless = payload => receipts.push(JSON.parse(payload));
  const query = { select: () => query, exec: async () => ({ owner, title: 'Note', content: 'abc', type: NoteType.Document }) };
  NoteModel.findOne = () => query;
  NoteModel.updateOne = () => ({ exec: async () => { document.getText('document-content').insert(0, 'later'); return { matchedCount: 1 }; } });
  await collaborationServer.configuration.onStoreDocument({ documentName: noteId, document });
  assert.equal(receipts[0].fingerprint, stored); assert.notEqual(receipts[0].fingerprint, fingerprint());
  document.destroy();
});


test('vault source paths are relative metadata and reject traversal and controls', async () => {
 const { validateSourcePath } = await import('../dist/util/validation.js');
 assert.equal(validateSourcePath('work/topic/note.md'), 'work/topic/note.md');
 for (const value of ['../note.md', '/root.md', 'C:/secret.md', 'a//b.md', 'bad\u0000.md', { $ne: '' }]) assert.throws(() => validateSourcePath(value));
});

test('awareness binds one session to the authenticated owner and strips untrusted fields', async () => {
  const context = { userId: owner, username: 'Authenticated owner', expiresAt: Date.now() + 60000 };
  const connection = { context, sendStateless() {} };
  const other = { context: { presenceClientId: 99, presenceColor: '#2563eb' } };
  const document = { getConnections: () => [connection, other] };
  const states = new Map([[1, { user: { id: 'forged', name: 'Administrator', color: 'url(evil)' }, cursor: { surface: 'board', x: 12, y: 34 }, calculator: { secret: 5 } }], [123, {}]]);
  await collaborationServer.configuration.beforeHandleAwareness({ context, connection, document, states });
  assert.equal(states.size, 1);
  assert.deepEqual(states.get(1).user, { id: owner, name: 'Authenticated owner', color: '#b91c1c' });
  assert.equal(states.get(1).calculator, undefined);
  assert.deepEqual(states.get(1).cursor, { surface: 'board', x: 12, y: 34 });
  await assert.rejects(collaborationServer.configuration.beforeHandleAwareness({ context, connection, document, states: new Map([[99, { user: {} }]]) }), /session mismatch/);
  const impostor = { userId: 'other', username: 'Other', expiresAt: Date.now() + 60000 };
  await assert.rejects(collaborationServer.configuration.beforeHandleAwareness({ context: impostor, connection: { context: impostor }, document, states: new Map([[99, { user: {} }]]) }), /already owned/);
  const invalid = new Map([[1, { user: {}, cursor: { surface: 'board', x: Infinity, y: 0 } }]]);
  await collaborationServer.configuration.beforeHandleAwareness({ context, connection, document, states: invalid });
  assert.equal(invalid.get(1).cursor, null);
});
