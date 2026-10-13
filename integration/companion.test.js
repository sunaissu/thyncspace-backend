import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
Object.assign(process.env, { CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'disposable_companion', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long' });
const { default: mongoose } = await import('mongoose');
const { default: Note } = await import('../dist/models/note.model.js');
const { default: User } = await import('../dist/models/user.model.js');
const { default: Grant } = await import('../dist/models/companionGrant.model.js');
const { default: Attachment } = await import('../dist/models/attachment.model.js');
const { default: Quota } = await import('../dist/models/attachmentQuota.model.js');
const api = await import('../dist/services/companion.js');
const { storeAttachment } = await import('../dist/services/attachments.js');
const { shutdownCollaborationServer } = await import('../dist/collaboration/server.js');
test('companion grants bind selective private sync to the owner and saved revision', { timeout: 180000 }, async t => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
 try {
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_companion' }); await Promise.all([Note.init(), User.init(), Grant.init(), Attachment.init(), Quota.init()]);
  const owner = await User.create({ username: 'Companion owner', email: 'owner@example.test' }), other = await User.create({ username: 'Other owner', email: 'other@example.test' });
  const note = await Note.create({ owner: owner.id, title: 'Selected private document', content: 'Original' });
  const hidden = await Note.create({ owner: owner.id, title: 'Not selected', content: 'Unselected secret' });
  const foreign = await Note.create({ owner: other.id, title: 'Foreign', sharedWith: [{ userId: owner.id, permission: 'editor' }] });
  const shared = await Note.create({ owner: owner.id, title: 'Shared document', sharedWith: [{ userId: other.id, permission: 'viewer' }] });
  const board = await Note.create({ owner: owner.id, title: 'Board', type: 'whiteboard' });
  const make = (ids = [note.id], changes = {}) => api.createCompanionGrant(owner.id, { clientId: randomUUID(), consent: true, name: 'Local study vault', noteIds: ids, attachments: true, ...changes });
  let grant, scope;
  await t.test('tokens are explicit, narrowly scoped, hashed at rest and never accepted as cookies', async () => {
   await assert.rejects(make([note.id], { consent: false }), error => error.status === 400);
   for (const excluded of [foreign, shared, board]) await assert.rejects(make([excluded.id]), error => error.status === 409);
   grant = await make(); assert.match(grant.token, /^thy_obs_[A-Za-z0-9_-]{43}$/); scope = await api.authenticateCompanion('Bearer ' + grant.token);
   const stored = await Grant.findById(grant.id).select('+tokenHash'); assert.match(stored.tokenHash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(stored).includes(grant.token), false);
   assert.equal(JSON.stringify(await api.listCompanionGrants(owner.id)).includes('token'), false);
   for (const invalid of [undefined, grant.token, 'Bearer random', 'Cookie ' + grant.token]) await assert.rejects(api.authenticateCompanion(invalid), error => error.status === 401);
   const list = await api.listCompanionNotes(scope); assert.equal(list.notes.length, 1); assert.equal(list.owner, owner.id); assert.equal(list.notes[0].id, note.id);
   for (const excluded of [hidden, foreign, shared, board]) await assert.rejects(api.readCompanionNote(scope, excluded.id), error => error.status === 404);
  });
  await t.test('two writers cannot silently replace each other and successful sync retains history', async () => {
   const results = await Promise.allSettled(['Local A', 'Local B'].map(content => api.updateCompanionNote(scope, note.id, { title: note.title, content, expectedRevision: 0 })));
   assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
   const saved = await api.readCompanionNote(scope, note.id); assert.equal(saved.revision, 1);
   await assert.rejects(api.updateCompanionNote(scope, note.id, { title: note.title, content: 'Stale', expectedRevision: 0 }), error => error.status === 409);
   assert.equal((await Note.findById(note.id).select('+history')).history.at(-1).content, 'Original');
   assert.equal((await api.updateCompanionNote(scope, note.id, { title: saved.title, content: saved.content, expectedRevision: saved.revision })).revision, 1);
  });
  await t.test('linked file access requires both token consent and a currently private scoped host', async () => {
   const file = await storeAttachment(owner.id, { name: 'measurements.txt', mime: 'text/plain', data: Buffer.from('Mass = 5 kg').toString('base64') });
   await Attachment.updateOne({ _id: file.id }, { $set: { references: [note.id] } });
   assert.equal((await api.companionAttachments(scope, note.id))[0].id, file.id); assert.equal((await api.readCompanionAttachment(scope, note.id, file.id)).data.toString(), 'Mass = 5 kg');
   await assert.rejects(api.companionAttachments({ ...scope, attachments: false }, note.id), error => error.status === 403);
   await assert.rejects(api.readCompanionAttachment(scope, hidden.id, file.id), error => error.status === 404);
   await Note.updateOne({ _id: note.id }, { $set: { sharedWith: [{ userId: other.id, permission: 'editor' }] } });
   assert.deepEqual((await api.listCompanionNotes(scope)).notes, [{ id: note.id, available: false }]);
   await assert.rejects(api.readCompanionNote(scope, note.id), error => error.status === 404);
   await assert.rejects(api.readCompanionAttachment(scope, note.id, file.id), error => error.status === 404);
   await assert.rejects(api.updateCompanionNote(scope, note.id, { title: note.title, content: 'No shared replacement', expectedRevision: 1 }), error => error.status === 404);
   await Note.updateOne({ _id: note.id }, { $set: { sharedWith: [] } });
  });
  await t.test('revoke, credential changes, expiry and concurrent connection limits are enforced', async () => {
   await assert.rejects(api.revokeCompanion(other.id, grant.id), error => error.status === 404);
   await api.revokeCompanion(owner.id, grant.id); await assert.rejects(api.authenticateCompanion('Bearer ' + grant.token), error => error.status === 401);
   await assert.rejects(api.updateCompanionNote(scope, note.id, { title: note.title, content: 'Revoked', expectedRevision: 1 }), error => error.status === 401);
   const next = await make(); await User.updateOne({ _id: owner.id }, { $inc: { credentialVersion: 1 } }); await assert.rejects(api.authenticateCompanion('Bearer ' + next.token), error => error.status === 401);
   await Grant.deleteMany({ owner: owner.id });
   const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => make())); assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 5); assert.equal(await Grant.countDocuments({ owner: owner.id }), 5);
   const expired = attempts.find(value => value.status === 'fulfilled').value; await Grant.updateOne({ _id: expired.id }, { $set: { expiresAt: new Date(0) } }); await assert.rejects(api.authenticateCompanion('Bearer ' + expired.token), error => error.status === 401);
   assert.equal(await Note.countDocuments({ owner: owner.id }), 4);
  });
 } finally { await shutdownCollaborationServer(); await mongoose.disconnect(); await replica.stop(); }
});
