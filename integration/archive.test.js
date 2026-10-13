import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
Object.assign(process.env, { CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'disposable_archive', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long' });
const { default: mongoose } = await import('mongoose');
const { default: Note } = await import('../dist/models/note.model.js');
const { default: Attachment } = await import('../dist/models/attachment.model.js');
const { default: Quota } = await import('../dist/models/attachmentQuota.model.js');
const { ArchiveImport, ArchiveItem } = await import('../dist/models/archiveImport.model.js');
const api = await import('../dist/services/workspaceArchive.js');
const { storeAttachment } = await import('../dist/services/attachments.js');
const oid = () => new mongoose.Types.ObjectId().toString();
test('portable archives restore privately and atomically with resumable uploads', { timeout: 180000 }, async t => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
 try {
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_archive' });
  await Promise.all([Note.init(), Attachment.init(), Quota.init(), ArchiveImport.init(), ArchiveItem.init()]);
  const owner = oid(), target = oid(), stranger = oid();
  const board = await Note.create({ owner, title: 'Board', type: 'whiteboard', content: JSON.stringify({ elements: [], viewport: { panX: 0, panY: 0, zoom: 1 } }) });
  const source = await Note.create({ owner, title: 'Document', content: `[[${board.id}|Sketch]]\n[[Board#section]]\n\n\`[[${board.id}]]\`\n\n\`\`\`md\n[[${board.id}]]\n\`\`\``, notebook: 'Research/Physics', sourcePath: 'Physics/Document.md', tags: ['physics'], isArchived: true, isTemplate: true, linkedSources: [{ noteId: board.id, sourceRevision: 2 }], sharedWith: [{ userId: stranger, permission: 'editor' }] });
  await Note.create({ owner, title: 'Trash', status: 'trashed', content: 'Keep in trash' });
  const hidden = await Note.create({ owner: stranger, title: 'Other owner secret', content: 'NEVER EXPORT' });
  const file = await storeAttachment(owner, { name: 'data.txt', mime: 'text/plain', data: Buffer.from('Measurements').toString('base64') });
  await Attachment.updateOne({ _id: file.id }, { $set: { references: [source.id, hidden.id] } });
  const lines = []; for await (const line of api.exportWorkspace(owner)) lines.push(JSON.parse(line));
  const records = lines.slice(1, -1), footer = lines.at(-1);
  assert.equal(footer.notes, 3); assert.equal(footer.files, 1); assert.equal(JSON.stringify(lines).includes('NEVER EXPORT'), false);
  assert.deepEqual(records.find(row => row.kind === 'attachment').data.references, [source.id]);
  const upload = async (user, values = records, digest = api.archiveHash(values.map(record => api.archiveHash(JSON.stringify(record)) + '\n').join(''))) => {
   const id = randomUUID(); await api.startArchive(user, { clientId: id, digest, records: values.length });
   for (let index = 0; index < values.length; index++) await api.stageArchive(user, id, index, values[index]);
   return id;
  };
  await t.test('resumption, owner boundaries, remapping, private copies and lost commit receipts', async () => {
   const id = randomUUID(), first = await api.startArchive(target, { clientId: id, digest: footer.digest, records: records.length }); assert.equal(first.next, 0);
   await api.stageArchive(target, id, 0, records[0]);
   assert.equal((await api.startArchive(target, { clientId: id, digest: footer.digest, records: records.length })).next, 1);
   assert.equal((await api.stageArchive(target, id, 0, records[0])).next, 1);
   await assert.rejects(api.stageArchive(target, id, 0, { ...records[0], id: oid() }), /changed/);
   await assert.rejects(api.stageArchive(stranger, id, 1, records[1]), /expired/);
   await assert.rejects(api.commitArchive(target, id), /every archive record/);
   assert.equal(await Note.countDocuments({ owner: target }), 0);
   for (let index = 1; index < records.length; index++) await api.stageArchive(target, id, index, records[index]);
   const results = await Promise.all([api.commitArchive(target, id), api.commitArchive(target, id)]);
   assert.deepEqual(results[0].noteIds, results[1].noteIds);
   const restored = await Note.find({ owner: target }), doc = restored.find(note => note.title === 'Document'), sketch = restored.find(note => note.title === 'Board');
   assert.equal(restored.length, 3); assert.equal(doc.notebook, 'Research/Physics'); assert.equal(doc.sourcePath, 'Physics/Document.md'); assert.deepEqual(doc.tags, ['physics']); assert.ok(doc.isArchived && doc.isTemplate);
   assert.equal(doc.sharedWith.length, 0); assert.equal(doc.sharedNotebookId, null); assert.equal(doc.contentRevision, 0);
   assert.ok(doc.content.startsWith(`[[${sketch.id}|Sketch]]`)); assert.ok(doc.content.includes(`[[${sketch.id}#section|Board#section]]`)); assert.ok(doc.content.includes('`[[' + board.id + ']]`')); assert.ok(doc.content.includes('```md\n[[' + board.id + ']]'));
   assert.equal(doc.linkedSources[0].noteId, sketch.id); assert.equal(doc.linkedSources[0].sourceRevision, 0); assert.equal(restored.find(note => note.title === 'Trash').status, 'trashed');
   const restoredFile = await Attachment.findOne({ owner: target }).select('+data'); assert.equal(restoredFile.data.toString(), 'Measurements'); assert.deepEqual(restoredFile.references, [doc.id]);
   assert.equal(await ArchiveItem.countDocuments({ owner: target }), 0); assert.equal((await api.commitArchive(target, id)).noteIds.length, 3); assert.equal(await Note.countDocuments({ owner: target }), 3);
  });
  await t.test('checksum failure and attachment quota failure roll back every visible change', async () => {
   const badOwner = oid(), badId = await upload(badOwner, records, '0'.repeat(64));
   await assert.rejects(api.commitArchive(badOwner, badId), /checksum/); assert.equal(await Note.countDocuments({ owner: badOwner }), 0); assert.equal(await ArchiveItem.countDocuments({ owner: badOwner }), records.length);
   await api.cancelArchive(badOwner, badId); assert.equal(await ArchiveItem.countDocuments({ owner: badOwner }), 0);
   const id = await upload(badOwner); await Quota.create({ owner: badOwner, bytes: 50 * 1024 * 1024, count: 100 });
   await assert.rejects(api.commitArchive(badOwner, id), /storage limit/); assert.equal(await Note.countDocuments({ owner: badOwner }), 0); assert.equal(await Attachment.countDocuments({ owner: badOwner }), 0); assert.equal((await ArchiveImport.findById(badOwner)).status, 'loading');
   await Quota.updateOne({ owner: badOwner }, { $set: { bytes: 0, count: 0 } }); assert.equal((await api.commitArchive(badOwner, id)).status, 'complete');
  });
  await t.test('malformed boards, paths, duplicate IDs and missing attachment hosts fail safely', async () => {
   const user = oid(), id = randomUUID(), doc = records.find(row => row.kind === 'note'), boardRow = records.find(row => row.data.type === 'whiteboard');
   await api.startArchive(user, { clientId: id, digest: '0'.repeat(64), records: 3 });
   await assert.rejects(api.stageArchive(user, id, 0, { ...doc, data: { ...doc.data, sourcePath: '../secret' } }), /path/i);
   await assert.rejects(api.stageArchive(user, id, 0, { ...boardRow, data: { ...boardRow.data, content: Buffer.from('{"elements":[{"type":"script"}]}').toString('base64') } }), /Whiteboard/);
   await api.stageArchive(user, id, 0, doc); await assert.rejects(api.stageArchive(user, id, 1, doc)); assert.equal((await ArchiveImport.findById(user)).next, 1);
   await api.cancelArchive(user, id);
   const attachment = records.find(row => row.kind === 'attachment'), broken = { ...attachment, data: { ...attachment.data, references: [oid()] } }, second = await upload(user, [broken]);
   await assert.rejects(api.commitArchive(user, second), /missing from the archive/); assert.equal(await Attachment.countDocuments({ owner: user }), 0);
  });
  await t.test('expanded title links cannot restore content above the normal save limit', async () => {
   const user = oid(), document = records.find(row => row.data.type === 'document'), board = records.find(row => row.data.type === 'whiteboard');
   const large = { ...document, data: { ...document.data, content: Buffer.from('[[Board]]'.repeat(60000)).toString('base64') } };
   const id = await upload(user, [large, board]); await assert.rejects(api.commitArchive(user, id), error => error.status === 413);
   assert.equal(await Note.countDocuments({ owner: user }), 0); assert.equal((await ArchiveImport.findById(user)).status, 'loading');
  });
  await t.test('same-owner JPEG restores reuse admitted bytes without another lossy encode', async () => {
   const { default: sharp } = await import('sharp'), imageOwner = oid();
   const pixels = Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, index) => (index * 71) % 256));
   const jpg = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } }).jpeg({ quality: 91 }).toBuffer();
   const image = await storeAttachment(imageOwner, { name: 'image.jpg', mime: 'image/jpeg', data: jpg.toString('base64') });
   const saved = await Attachment.findById(image.id).select('+data');
   const rows = []; for await (const line of api.exportWorkspace(imageOwner)) rows.push(JSON.parse(line));
   const id = await upload(imageOwner, rows.slice(1, -1)); const result = await api.commitArchive(imageOwner, id);
   assert.equal(result.reusedFiles, 1); assert.equal(await Attachment.countDocuments({ owner: imageOwner }), 1); assert.deepEqual((await Attachment.findById(image.id).select('+data')).data, saved.data);
  });
  await t.test('same-owner restore reuses existing file bytes without changing their metadata', async () => {
   const id = await upload(owner), result = await api.commitArchive(owner, id); assert.equal(result.reusedFiles, 1); assert.equal(await Attachment.countDocuments({ owner }), 1); assert.equal((await Quota.findOne({ owner })).count, 1); assert.equal((await Attachment.findById(file.id)).references.length, 3);
  });
 } finally { await mongoose.disconnect(); await replica.stop(); }
});
