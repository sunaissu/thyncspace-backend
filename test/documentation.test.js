import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { createHash } from 'node:crypto';

for (const [key, value] of Object.entries({ CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'documentation-test-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test-client', GOOGLE_AUTH_CLIENT_SECRET: 'test-secret', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://localhost:27017', MONGO_DB_NAME: 'documentation_test', SESSION_SECRET: 'documentation-test-session-secret-at-least-32-characters' })) process.env[key] ??= value;

const { parseDocumentationContent, validateNoteContentForType, validateNoteType, MAX_NOTE_CONTENT_BYTES } = await import('../dist/util/validation.js');
const { documentationContentFromDocument, replaceDocumentationContent } = await import('../dist/util/documentation.js');
const { collaborationSnapshot } = await import('../dist/util/collaborationSnapshot.js');
const { NoteType } = await import('../dist/types/_enums.js');
const { validateCollaborationUpdate, collaborationServer } = await import('../dist/collaboration/server.js');
const { default: Note } = await import('../dist/models/note.model.js');
const { default: Workspace } = await import('../dist/models/workspace.model.js');
const { createNote, updatePrivateNote, updateNote } = await import('../dist/controller/notes.js');
const { updateWorkspace } = await import('../dist/controller/workspace.js');
const { validateArchiveRecord, remapArchivedNoteContent } = await import('../dist/services/workspaceArchive.js');
const { validateSelectionSource } = await import('../dist/util/linkedSelection.js');

const owner = '64b000000000000000000002', noteId = '64b000000000000000000001';
const text = (id = 'intro', content = 'Starting text') => ({ id, type: 'text', title: 'Introduction', content });
const board = (id = 'diagram') => ({ id, type: 'board', title: 'Diagram', caption: 'A sketch', height: 420, elements: [{ id: 'box', type: 'rectangle', x: 1, y: 2, width: 30, height: 40, text: 'Original' }], viewport: { panX: 0, panY: 0, zoom: 1 } });
const documentation = (sections = [text(), board()]) => ({ format: 'thyncspace-documentation', version: 1, sections });
const seeded = content => { const document = new Y.Doc(); document.transact(() => replaceDocumentationContent(document, content)); return document; };
const invoke = async (handler, body = {}, userId = owner) => {
  const result = {};
  const res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } };
  await handler({ user: { id: userId }, params: { noteId }, body }, res, error => { result.error = error; });
  return result;
};
const stubFind = (model, value, t) => {
  const original = model.findOne;
  model.findOne = () => { const query = { select: () => query, exec: async () => value }; return query; };
  t.after(() => { model.findOne = original; });
};

test('Documentation JSON accepts the new type and strips unknown fields without adding renderer defaults', () => {
  assert.equal(validateNoteType('documentation'), NoteType.Documentation);
  assert.deepEqual(parseDocumentationContent(''), documentation([]));
  const input = documentation();
  input.sections[1].elements[0].link = { kind: 'url', target: 'https://example.com', secret: 'drop' };
  input.sections[1].elements[0].unknown = { secret: true };
  input.sections[0].secret = true;
  input.secret = true;
  const parsed = parseDocumentationContent(input);
  assert.equal(parsed.secret, undefined); assert.equal(parsed.sections[0].secret, undefined);
  const element = parsed.sections[1].elements[0];
  assert.deepEqual(element.link, { kind: 'url', target: 'https://example.com' });
  assert.equal(element.unknown, undefined); assert.equal(element.strokeColor, undefined);
  assert.equal(input.sections[1].elements[0].link.secret, 'drop');
  assert.deepEqual(JSON.parse(validateNoteContentForType(JSON.stringify(input), NoteType.Documentation)), parsed);
});

test('Documentation rejects duplicate or unsafe IDs, oversized content and invalid board metadata', () => {
  const invalid = [documentation([text('duplicate'), text('duplicate')]), documentation([text('../bad')]), documentation(Array.from({ length: 41 }, (_, index) => text(`s${index}`))),
    documentation([{ ...text(), title: 'x'.repeat(121) }]), documentation([{ ...board(), caption: 'x'.repeat(501) }]),
    documentation([{ ...board(), height: 279 }]), documentation([{ ...board(), height: 901 }]),
    documentation([{ ...board(), viewport: { panX: 0, panY: 0, zoom: 0 } }]), documentation([{ ...text(), type: 'unknown' }]),
    documentation([text('large', 'é'.repeat(MAX_NOTE_CONTENT_BYTES / 2))])];
  const unsafe = board(); unsafe.elements[0].link = { kind: 'url', target: 'javascript:alert(1)' }; invalid.push(documentation([unsafe]));
  const badFrame = board(); badFrame.elements[0] = { ...badFrame.elements[0], type: 'frame', name: { unsafe: true } }; invalid.push(documentation([badFrame]));
  for (const input of invalid) assert.equal(parseDocumentationContent(input), undefined);
  assert.throws(() => validateNoteContentForType(JSON.stringify(invalid.at(-3)), NoteType.Documentation));
  assert.throws(() => validateNoteContentForType('x'.repeat(MAX_NOTE_CONTENT_BYTES + 1), NoteType.Documentation), { status: 413 });
});

test('Documentation Yjs seed and replacement round trip text, boards and viewports', () => {
  const input = documentation(), document = seeded(input);
  assert.deepEqual(documentationContentFromDocument(document), input);
  assert.ok(document.getMap('documentation-elements:diagram').get('box').get('text') instanceof Y.Text);
  document.transact(() => replaceDocumentationContent(document, documentation([text('only', 'Replacement')])));
  assert.deepEqual(documentationContentFromDocument(document), documentation([text('only', 'Replacement')]));
  assert.ok(document.getMap('documentation-elements:diagram').size, 'deleted stores can remain for undo');
  document.destroy();
});

test('concurrent edits to separate text and board sections merge without replacing either section', () => {
  const left = seeded(documentation()), right = new Y.Doc(); Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  left.getText('documentation-text:intro').insert(13, ' from editor one');
  right.getMap('documentation-elements:diagram').get('box').get('text').insert(8, ' from editor two');
  right.getMap('documentation-sections').get('diagram').set('caption', 'Updated caption');
  const leftUpdate = Y.encodeStateAsUpdate(left), rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate); Y.applyUpdate(right, leftUpdate);
  assert.deepEqual(documentationContentFromDocument(left), documentationContentFromDocument(right));
  assert.equal(documentationContentFromDocument(left).sections[0].content, 'Starting text from editor one');
  assert.equal(documentationContentFromDocument(left).sections[1].elements[0].text, 'Original from editor two');
  assert.equal(collaborationSnapshot(left, NoteType.Documentation), collaborationSnapshot(right, NoteType.Documentation));
  left.destroy(); right.destroy();
});

test('materialized snapshots deduplicate order, append missing IDs deterministically and ignore deleted content', () => {
  const document = seeded(documentation([text('z'), text('a'), board()]));
  const order = document.getArray('documentation-order'); order.delete(0, order.length); order.insert(0, ['diagram', 'diagram', 'deleted']);
  assert.deepEqual(documentationContentFromDocument(document).sections.map(section => section.id), ['diagram', 'a', 'z']);
  const elementOrder = document.getArray('documentation-order:diagram'); elementOrder.insert(0, ['box', 'box']);
  assert.equal(documentationContentFromDocument(document).sections[0].elements.length, 1);
  const snapshot = collaborationSnapshot(document, NoteType.Documentation);
  document.getText('documentation-text:deleted').insert(0, 'Orphaned undo content');
  document.getText('calculator-scratch').insert(0, 'Private calculations');
  assert.equal(collaborationSnapshot(document, NoteType.Documentation), snapshot);
  const parsed = JSON.parse(snapshot); assert.equal(parsed.content.format, 'thyncspace-documentation');
  document.destroy();
});

test('Documentation admission rejects malformed updates on a replica without changing the live document', () => {
  const original = seeded(documentation()), originalSnapshot = collaborationSnapshot(original, NoteType.Documentation);
  const badUpdates = [peer => peer.getMap('documentation-sections').set('bad', 123),
    peer => peer.getMap('documentation-sections').get('diagram').set('height', 100),
    peer => peer.getMap('documentation-elements:diagram').get('box').set('id', 'different-id'),
    peer => peer.getText('documentation-text:intro').insert(0, 'x'.repeat(MAX_NOTE_CONTENT_BYTES))];
  for (const mutate of badUpdates) {
    const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(original)); mutate(peer);
    assert.throws(() => validateCollaborationUpdate(original, Y.encodeStateAsUpdate(peer), NoteType.Documentation));
    assert.equal(collaborationSnapshot(original, NoteType.Documentation), originalSnapshot); peer.destroy();
  }
  const valid = new Y.Doc(); Y.applyUpdate(valid, Y.encodeStateAsUpdate(original)); valid.getText('documentation-text:intro').insert(0, 'Valid ');
  assert.doesNotThrow(() => validateCollaborationUpdate(original, Y.encodeStateAsUpdate(valid), NoteType.Documentation));
  valid.destroy(); original.destroy();
});

test('Documentation load, durable acknowledgement and history use the same materialized state', async t => {
  const initial = documentation(), content = JSON.stringify(initial);
  const note = { owner: { toString: () => owner }, title: 'Guide', type: NoteType.Documentation, content };
  stubFind(Note, note, t);
  const loaded = await collaborationServer.configuration.onLoadDocument({ documentName: noteId });
  assert.deepEqual(documentationContentFromDocument(loaded), initial);
  let mutation, acknowledgement;
  const originalUpdate = Note.updateOne; t.after(() => { Note.updateOne = originalUpdate; });
  Note.updateOne = (_filter, value) => ({ exec: async () => { mutation = value; return { matchedCount: 1 }; } });
  loaded.broadcastStateless = message => { acknowledgement = JSON.parse(message); };
  await collaborationServer.configuration.onStoreDocument({ documentName: noteId, document: loaded });
  assert.equal(mutation.$push, undefined); assert.equal(mutation.$inc, undefined);
  loaded.getText('documentation-text:intro').insert(0, 'Updated ');
  await collaborationServer.configuration.onStoreDocument({ documentName: noteId, document: loaded });
  assert.equal(mutation.$push.history.$each[0].content, content); assert.equal(mutation.$push.history.$slice, -5);
  assert.equal(mutation.$inc.contentRevision, 1);
  assert.deepEqual(JSON.parse(mutation.$set.content), documentationContentFromDocument(loaded));
  assert.equal(acknowledgement.fingerprint, createHash('sha256').update(collaborationSnapshot(loaded, NoteType.Documentation)).digest('hex'));
  loaded.destroy();
});

test('Documentation create uses the canonical empty default and private/shared permissions remain enforced', async t => {
  const originalCreate = Note.create; t.after(() => { Note.create = originalCreate; });
  let created; Note.create = async value => { created = new Note(value); return created; };
  const result = await invoke(createNote, { title: 'Guide', type: 'documentation' });
  assert.ifError(result.error); assert.equal(result.status, 201); assert.deepEqual(JSON.parse(created.content), documentation([]));
  stubFind(Note, { owner: { toString: () => 'another-owner' }, sharedWith: [], type: NoteType.Documentation }, t);
  assert.equal((await invoke(updatePrivateNote, { text: JSON.stringify(documentation([])) })).error.status, 403);
  Note.findOne = () => { const query = { select: () => query, exec: async () => ({ owner: { toString: () => owner }, sharedWith: [{ userId: 'peer', permission: 'editor' }], type: NoteType.Documentation }) }; return query; };
  assert.equal((await invoke(updatePrivateNote, { text: JSON.stringify(documentation([])) })).error.status, 409);
  assert.equal((await invoke(updateNote, { text: JSON.stringify(documentation([])) })).error.status, 409);
});

test('workspace archives admit Documentation and remap only text-section links', async () => {
  const input = documentation([text('intro', `[[${noteId}|Reference]]`), board()]);
  const record = await validateArchiveRecord({ kind: 'note', id: noteId, data: { title: 'Guide', type: 'documentation', content: Buffer.from(JSON.stringify(input)).toString('base64'), contentEncoding: 'base64', status: 'active', notebook: '', tags: [], linkedSources: [] } });
  assert.equal(JSON.parse(record.payload).type, NoteType.Documentation);
  const remapped = JSON.parse(remapArchivedNoteContent(JSON.stringify(input), NoteType.Documentation, new Map([[noteId, owner]])));
  assert.equal(remapped.sections[0].content, `[[${owner}|Reference]]`); assert.deepEqual(remapped.sections[1], input.sections[1]);
});

test('saved searches accept Documentation and partial linked selections remain unsupported', async t => {
  const workspace = new Workspace({ owner }); workspace.save = async () => workspace; stubFind(Workspace, workspace, t);
  const result = await invoke(updateWorkspace, { action: 'save-search', search: { id: 'guides', name: 'Guides', query: '', notebook: '', tag: '', owner: 'all', type: 'documentation', view: 'documentation', from: '', to: '' } });
  assert.ifError(result.error); assert.equal(result.body.searches[0].type, 'documentation');
  const source = { type: 'documentation', content: JSON.stringify(documentation()), contentRevision: 0 };
  assert.doesNotThrow(() => validateSelectionSource(null, source));
  assert.throws(() => validateSelectionSource({ kind: 'lines', start: 1, end: 1, revision: 0 }, source), { status: 400 });
  assert.throws(() => validateSelectionSource({ kind: 'elements', ids: ['box'], revision: 0 }, source), { status: 400 });
});
