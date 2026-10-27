import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';

// This test creates its own replica set and never reads the application's .env.
Object.assign(process.env, { CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'documentation-integration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'disposable_documentation', SESSION_SECRET: 'documentation-integration-session-at-least-32-characters' });
const { default: mongoose } = await import('mongoose');
const { default: Note } = await import('../dist/models/note.model.js');
const { default: User } = await import('../dist/models/user.model.js');
const { default: DeviceSession } = await import('../dist/models/deviceSession.model.js');
const { default: Attachment } = await import('../dist/models/attachment.model.js');
const { default: Quota } = await import('../dist/models/attachmentQuota.model.js');
const { ArchiveImport, ArchiveItem } = await import('../dist/models/archiveImport.model.js');
const notes = await import('../dist/controller/notes.js');
const { recoverNote } = await import('../dist/controller/noteLibrary.js');
const archives = await import('../dist/services/workspaceArchive.js');
const { createCollaborationToken } = await import('../dist/util/collaborationToken.js');
const { documentationContentFromDocument } = await import('../dist/util/documentation.js');
const { collaborationSnapshot } = await import('../dist/util/collaborationSnapshot.js');
const { attachCollaborationServer, collaborationServer, flushNoteState, shutdownCollaborationServer } = await import('../dist/collaboration/server.js');
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
};
const invoke = async (handler, userId, noteId, body = {}) => {
  const result = {}, res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } };
  await handler({ user: { id: userId }, params: { noteId }, body }, res, error => { result.error = error; });
  return result;
};
const content = { format: 'thyncspace-documentation', version: 1, sections: [
  { id: 'intro', type: 'text', title: 'Introduction', content: 'Initial text' },
  { id: 'diagram', type: 'board', title: 'Diagram', caption: '', height: 420, elements: [{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 80, text: 'Original' }], viewport: { panX: 0, panY: 0, zoom: 1 } },
] };

// A minimal protocol client keeps this backend test independent of browser UI and frontend dependencies.
async function connectClient(port, noteId, token) {
  const document = new Y.Doc(), receipts = [], statuses = [], errors = [];
  let authenticated = false;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration`, { origin: 'http://localhost:3000' });
  const frame = type => { const encoder = encoding.createEncoder(); encoding.writeVarString(encoder, noteId); encoding.writeVarUint(encoder, type); return encoder; };
  socket.on('message', data => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data)); assert.equal(decoding.readVarString(decoder), noteId);
      const type = decoding.readVarUint(decoder);
      if (type === 2) {
        const auth = decoding.readVarUint(decoder);
        if (auth === 1) throw new Error(decoding.readVarString(decoder));
        if (auth === 2) { authenticated = true; decoding.readVarString(decoder); const encoder = frame(0); sync.writeSyncStep1(encoder, document); socket.send(encoding.toUint8Array(encoder)); }
      } else if (type === 0 || type === 4) {
        const encoder = frame(0), length = encoding.length(encoder);
        sync.readSyncMessage(decoder, encoder, document, 'remote');
        if (encoding.length(encoder) > length) socket.send(encoding.toUint8Array(encoder));
      } else if (type === 5) receipts.push(JSON.parse(decoding.readVarString(decoder)));
      else if (type === 8) statuses.push(decoding.readVarUint(decoder));
      else if (type === 9) socket.send(encoding.toUint8Array(frame(10)));
    } catch (error) { errors.push(error); }
  });
  socket.on('error', error => errors.push(error));
  document.on('update', (update, origin) => {
    if (origin === 'remote' || socket.readyState !== WebSocket.OPEN) return;
    const encoder = frame(0); sync.writeUpdate(encoder, update); socket.send(encoding.toUint8Array(encoder));
  });
  await once(socket, 'open');
  const auth = frame(2); encoding.writeVarUint(auth, 0); encoding.writeVarString(auth, token); socket.send(encoding.toUint8Array(auth));
  await waitFor(() => { if (errors.length) throw errors[0]; return authenticated && document.getMap('documentation-sections').size === 2; }, 'authenticated Documentation sync');
  return { document, receipts, statuses, errors, socket, close: async () => { if (socket.readyState === WebSocket.OPEN) { const closed = once(socket, 'close'); socket.close(); await closed; } else socket.terminate(); document.destroy(); } };
}

test('Documentation saves, shares, merges sections, acknowledges durability and restores privately', { timeout: 180000 }, async () => {
  const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
  const server = createServer(), clients = [];
  try {
    await mongoose.connect(replica.getUri(), { dbName: 'disposable_documentation' });
    await Promise.all([Note.init(), User.init(), DeviceSession.init(), Attachment.init(), Quota.init(), ArchiveImport.init(), ArchiveItem.init()]);
    const owner = await User.create({ username: 'Documentation owner', email: 'documentation-owner@example.test' });
    const peer = await User.create({ username: 'Documentation peer', email: 'documentation-peer@example.test' });
    const sessions = new Map();
    for (const user of [owner, peer]) { const hash = randomBytes(32).toString('hex'); sessions.set(user.id, hash); await DeviceSession.create({ userId: user.id, sessionHash: hash, expiresAt: new Date(Date.now() + 3600000) }); }
    const created = await invoke(notes.createNote, owner.id, undefined, { title: 'Integration guide', type: 'documentation', text: JSON.stringify(content) });
    assert.ifError(created.error); const noteId = String(created.body._id);
    const privateContent = structuredClone(content); privateContent.sections[0].content = 'Private save';
    const saved = await invoke(notes.updatePrivateNote, owner.id, noteId, { text: JSON.stringify(privateContent), expectedRevision: 0 });
    assert.ifError(saved.error); assert.equal(saved.body.contentRevision, 1);
    assert.equal((await invoke(notes.updatePrivateNote, peer.id, noteId, { text: JSON.stringify(content), expectedRevision: 1 })).error.status, 403);
    const shared = await invoke(notes.shareNote, owner.id, noteId, { identifier: peer.username, permission: 'editor', snapshot: { text: JSON.stringify(privateContent), expectedRevision: 1 } });
    assert.ifError(shared.error);
    assert.equal((await invoke(notes.updatePrivateNote, owner.id, noteId, { text: JSON.stringify(content), expectedRevision: 1 })).error.status, 409);
    attachCollaborationServer(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const connect = async user => { const client = await connectClient(server.address().port, noteId, createCollaborationToken(noteId, user.id, sessions.get(user.id))); clients.push(client); return client; };
    const left = await connect(owner), right = await connect(peer);
    left.document.getText('documentation-text:intro').insert(12, ' and Alice');
    right.document.getMap('documentation-elements:diagram').get('box').get('text').insert(8, ' and Bob');
    await waitFor(() => documentationContentFromDocument(left.document).sections[1].elements[0].text === 'Original and Bob'
      && documentationContentFromDocument(right.document).sections[0].content === 'Private save and Alice', 'concurrent different-section edits');
    const live = collaborationServer.documents.get(noteId);
    assert.equal(collaborationSnapshot(left.document, 'documentation'), collaborationSnapshot(right.document, 'documentation'));
    await flushNoteState(noteId);
    const fingerprint = createHash('sha256').update(collaborationSnapshot(live, 'documentation')).digest('hex');
    await waitFor(() => left.receipts.some(value => value.type === 'stored' && value.fingerprint === fingerprint)
      && right.receipts.some(value => value.type === 'stored' && value.fingerprint === fingerprint), 'matching durable receipts');
    const persisted = await Note.findById(noteId).select('+collaborationState +history');
    assert.deepEqual(JSON.parse(persisted.content), documentationContentFromDocument(live)); assert.ok(persisted.collaborationState.length);
    assert.ok(persisted.history.some(version => JSON.parse(version.content).sections[0].content === 'Private save'));

    assert.ifError((await invoke(notes.shareNote, owner.id, noteId, { identifier: peer.username, permission: 'viewer' })).error);
    await waitFor(() => live.getConnections().filter(connection => connection.context.userId === peer.id).every(connection => connection.readOnly), 'viewer permission');
    right.statuses.length = 0;
    right.document.getText('documentation-text:intro').insert(0, 'FORBIDDEN ');
    await waitFor(() => right.statuses.includes(0), 'viewer update denied');
    assert.equal(documentationContentFromDocument(live).sections[0].content, 'Private save and Alice');
    await left.close(); await right.close();
    await waitFor(() => !collaborationServer.documents.has(noteId), 'live document unload');
    const reopened = await connect(owner);
    assert.deepEqual(documentationContentFromDocument(reopened.document), JSON.parse(persisted.content));
    assert.equal(reopened.document.getMap('documentation-elements:diagram').get('box').get('text').toString(), 'Original and Bob');
    await reopened.close();

    const records = []; for await (const line of archives.exportWorkspace(owner.id)) records.push(JSON.parse(line));
    const footer = records.pop(); records.shift();
    const target = new mongoose.Types.ObjectId().toString(), requestId = randomUUID();
    await archives.startArchive(target, { clientId: requestId, digest: footer.digest, records: records.length });
    for (let index = 0; index < records.length; index++) await archives.stageArchive(target, requestId, index, records[index]);
    const restored = await archives.commitArchive(target, requestId), copy = await Note.findById(restored.noteIds[0]);
    assert.equal(copy.type, 'documentation'); assert.deepEqual(JSON.parse(copy.content), JSON.parse(persisted.content));
    assert.equal(copy.sharedWith.length, 0); assert.equal(String(copy.owner), target);
    const recovered = await invoke(recoverNote, owner.id, noteId, { versionId: persisted.history.at(-1)._id.toString() });
    assert.ifError(recovered.error); assert.equal(recovered.body.type, 'documentation'); assert.equal(recovered.body.sharedWith.length, 0);
    assert.notEqual(String(recovered.body._id), noteId);
    assert.deepEqual(clients.flatMap(client => client.errors), []);
  } finally {
    for (const client of clients) if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    await shutdownCollaborationServer(); await collaborationServer.hooks('onDestroy', {});
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect(); await replica.stop();
  }
});
