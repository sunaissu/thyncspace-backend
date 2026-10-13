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
const workspace = await import('../dist/controller/workspace.js');
const devices = await import('../dist/controller/deviceSessions.js');
const deviceUtil = await import('../dist/util/deviceSessions.js');
const { default: DeviceSession } = await import('../dist/models/deviceSession.model.js');
const { default: Workspace } = await import('../dist/models/workspace.model.js');
const { collaborationServer, shutdownCollaborationServer } = await import('../dist/collaboration/server.js');
const owner = new mongoose.Types.ObjectId().toString();
const stranger = new mongoose.Types.ObjectId().toString();
async function invoke(handler, { noteId, versionId, deviceId, scheduleId, method = "POST", sessionID = "test-current-session", body = {}, userId = owner } = {}) {
 const result = {};
 const response = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; }, sendStatus(code) { result.status = code; return this; } };
 await handler({ user: { id: userId }, params: { noteId, versionId, deviceId, scheduleId }, method, body, sessionID, get: () => "Integration browser", session: { cookie: { expires: new Date(Date.now() + 3600000) }, destroy(callback) { result.destroyed = true; callback(); } } }, response, error => { result.error = error; });
 return result;
}

test('real replica-set import, concurrent saves, history, trash and recovery', { timeout: 180000 }, async t => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
 try {
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_review' });
  await Workspace.init();
  await DeviceSession.init();
  await t.test('device sessions bind live tokens and revoke only the selected owner session', async () => {
   for (const sessionID of ['test-current-session', 'other-session']) assert.ifError((await invoke(deviceUtil.trackDeviceSession, { sessionID })).error);
   const hash = deviceUtil.sessionFingerprint('other-session');
   let list = await invoke(devices.listDeviceSessions);
   assert.equal(list.body.length, 2); assert.equal(list.body.filter(device => device.current).length, 1);
   assert.equal(JSON.stringify(list.body).includes(hash), false);
   const other = list.body.find(device => !device.current);
   assert.equal((await invoke(devices.revokeDeviceSession, { deviceId: other.id, userId: stranger })).error?.status, 404);
   assert.equal((await invoke(devices.revokeDeviceSession, { deviceId: 'invalid' })).error?.status, 400);
   await deviceUtil.assertActiveDeviceSession(hash, owner);
   await assert.rejects(deviceUtil.assertActiveDeviceSession(hash, stranger), /Session expired/);
   const { createCollaborationToken, verifyCollaborationToken } = await import('../dist/util/collaborationToken.js');
   const token = createCollaborationToken(new mongoose.Types.ObjectId().toString(), owner, hash);
   assert.equal(verifyCollaborationToken(token).sessionHash, hash);
   assert.throws(() => createCollaborationToken('note', owner, undefined), /device session/);
   const revoked = await invoke(devices.revokeDeviceSession, { deviceId: other.id });
   assert.ifError(revoked.error); assert.equal(revoked.body.current, false);
   await assert.rejects(deviceUtil.assertActiveDeviceSession(hash, owner), /Session expired/);
   const stale = await invoke(deviceUtil.trackDeviceSession, { sessionID: 'other-session' });
   assert.equal(stale.error?.status, 401); assert.equal(stale.destroyed, true);
   assert.ok((await DeviceSession.findById(other.id)).revokedAt);
   list = await invoke(devices.listDeviceSessions); assert.equal(list.body.length, 1);
   const current = await invoke(devices.revokeDeviceSession, { deviceId: list.body[0].id });
   assert.equal(current.body.current, true); assert.equal(current.destroyed, true);
  });

  await t.test('workspace pins, recent notes and searches are bounded and account isolated', async () => {
   const own = await Note.create({ owner, title: 'Pinned', type: 'document' });
   const shared = await Note.create({ owner: stranger, title: 'Shared', type: 'document', sharedWith: [{ userId: owner, permission: 'viewer' }] });
   const hidden = await Note.create({ owner: stranger, title: 'Hidden', type: 'document' });
   assert.equal((await invoke(workspace.updateWorkspace, { body: { action: 'pin', noteId: hidden.id } })).error?.status, 404);
   assert.equal((await invoke(workspace.updateWorkspace, { body: { action: 'open', noteId: { $ne: '' } } })).error?.status, 400);
   const concurrent = await Promise.all([own, shared].map(note => invoke(workspace.updateWorkspace, { body: { action: 'pin', noteId: note.id } })));
   concurrent.forEach(result => assert.ifError(result.error));
   let saved = await invoke(workspace.getWorkspace);
   assert.deepEqual(new Set(saved.body.pinned), new Set([own.id, shared.id]));
   assert.deepEqual((await invoke(workspace.getWorkspace, { userId: stranger })).body.pinned, []);
   for (const source of [own, shared, own]) assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'open', noteId: source.id } })).error);
   saved = await invoke(workspace.getWorkspace);
   assert.deepEqual(saved.body.recent.map(item => item.noteId), [own.id, shared.id]);
   const search = { id: 'saved-search', name: 'My work', query: '$literal', notebook: 'Work/Study', tag: 'MATH', owner: 'mine', type: 'document', view: 'all', from: '2026-01-01', to: '2026-12-31' };
   assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'save-search', search } })).error);
   for (const invalid of [{ to: '2026-02-31' }, { from: '2027-01-01' }, { owner: { $ne: '' } }, { query: 'bad\u0000' }, { view: 'unknown' }]) {
    assert.equal((await invoke(workspace.updateWorkspace, { body: { action: 'save-search', search: { ...search, ...invalid } } })).error?.status, 400);
   }
   for (let index = 1; index < 20; index++) assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'save-search', search: { ...search, id: 'search-' + index } } })).error);
   assert.equal((await invoke(workspace.updateWorkspace, { body: { action: 'save-search', search: { ...search, id: 'overflow' } } })).error?.status, 409);
   assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'save-search', search: { ...search, name: 'Renamed' } } })).error);
   saved = await invoke(workspace.getWorkspace);
   assert.equal(saved.body.searches.length, 20); assert.equal(saved.body.searches.at(-1).tag, 'math');
   assert.equal(saved.body.searches.at(-1).query, '$literal'); assert.equal(saved.body.searches.at(-1).name, 'Renamed');
   assert.deepEqual((await invoke(workspace.getWorkspace, { userId: stranger })).body.searches, []);
   assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'delete-search', id: search.id } })).error);
   await Note.updateOne({ _id: shared.id }, { $set: { sharedWith: [] } });
   assert.equal((await invoke(workspace.updateWorkspace, { body: { action: 'open', noteId: shared.id } })).error?.status, 404);
   assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'unpin', noteId: shared.id } })).error);
   assert.ifError((await invoke(workspace.updateWorkspace, { body: { action: 'clear-recent' } })).error);
   assert.deepEqual((await invoke(workspace.getWorkspace)).body.recent, []);
   await Note.deleteMany({ _id: { $in: [own.id, shared.id, hidden.id] } });
  });
  let noteId;
  await t.test('bulk import returns the committed notes in input order', async () => {
   const imported = await invoke(notes.importNotes, { body: { notes: [{ title: 'First', text: 'base' }, { title: 'Second', text: '' }] } });
   assert.ifError(imported.error); assert.equal(imported.status, 201);
   assert.deepEqual(imported.body.map(n => n.title), ['First', 'Second']);
   noteId = imported.body[0]._id.toString();
   assert.equal(await Note.countDocuments({ owner }), 2);
  });
  await t.test('template metadata is owner-only and copies start as independent private notes', async () => {
   const changed = await invoke(library.updateOrganization, { noteId, body: { notebook: 'Templates', tags: [], isTemplate: true } });
   assert.ifError(changed.error); assert.equal(changed.body.isTemplate, true);
   assert.equal((await invoke(library.updateOrganization, { noteId, userId: stranger, body: { notebook: '', tags: [], isTemplate: false } })).error?.status, 404);
   assert.equal((await invoke(library.updateOrganization, { noteId, body: { notebook: '', tags: [], isTemplate: { $ne: false } } })).error?.status, 400);
   const { toNoteResponse } = await import('../dist/util/noteResponse.js');
   assert.equal(toNoteResponse(await Note.findById(noteId), stranger).isTemplate, undefined);
   const copy = await invoke(notes.createNote, { body: { title: 'Template copy', type: 'document', text: changed.body.content } });
   assert.ifError(copy.error); assert.notEqual(copy.body._id.toString(), noteId);
   assert.equal(copy.body.isTemplate, false); assert.equal(copy.body.sharedWith.length, 0);
   assert.equal((await Note.findById(noteId)).isTemplate, true);
  });
  await t.test('storage totals count UTF-8, history and snapshots without leaking other owners', async () => {
   const measured = await Note.create({ owner, title: 'Measured storage', type: 'document', status: 'trashed', content: 'a😊', collaborationState: Buffer.from([1, 2]), history: [{ title: 'Old', content: 'old', savedAt: new Date() }] });
   await Note.create({ owner: stranger, title: 'Other account secret', type: 'document', content: 'secret' });
   const result = await invoke(library.getStorageUsage);
   assert.ifError(result.error);
   const entry = result.body.largest.find(item => item._id.toString() === measured.id);
   assert.equal(entry.contentBytes, 5); assert.equal(entry.historyBytes, 3); assert.equal(entry.collaborationBytes, 2); assert.equal(entry.totalBytes, 10);
   assert.ok(result.body.totals.trashBytes >= 10);
   assert.equal(result.body.largest.some(item => item.title === 'Other account secret'), false);
  });
  await t.test('bulk moves are atomic and tag merges treat dollar-prefixed names literally', async () => {
   const first = await Note.create({ owner, title: 'Move one', type: 'document', content: 'keep', notebook: 'Old', tags: ['old', '$target'] });
   const second = await Note.create({ owner, title: 'Move two', type: 'document', notebook: 'Old', tags: ['old', 'other'] });
   const foreign = await Note.create({ owner: stranger, title: 'Foreign', type: 'document', notebook: 'Secret', tags: ['old'] });
   const denied = await invoke(library.bulkOrganization, { body: { action: 'move', noteIds: [first.id, foreign.id], notebook: 'Research/Physics' } });
   assert.equal(denied.error?.status, 404); assert.equal((await Note.findById(first.id)).notebook, 'Old');
   const moved = await invoke(library.bulkOrganization, { body: { action: 'move', noteIds: [first.id, second.id], notebook: 'Research/Physics' } });
   assert.ifError(moved.error); assert.equal(moved.body.affected, 2); assert.equal((await Note.findById(first.id)).content, 'keep');
   assert.equal((await invoke(library.bulkOrganization, { body: { action: 'move', noteIds: [first.id], notebook: 'a/../b' } })).error?.status, 400);
   const merged = await invoke(library.bulkOrganization, { body: { action: 'rename-tag', from: 'old', to: '$target' } });
   assert.ifError(merged.error); assert.equal(merged.body.affected, 2);
   assert.deepEqual((await Note.findById(first.id)).tags, ['$target']);
   assert.deepEqual(new Set((await Note.findById(second.id)).tags), new Set(['other', '$target']));
   assert.deepEqual((await Note.findById(foreign.id)).tags, ['old']);
  });
  await t.test('archiving is reversible owner-only organization and never revokes sharing', async () => {
   const first = await Note.create({ owner, title: 'Archive', type: 'document', content: 'keep', sharedWith: [{ userId: stranger, permission: 'editor' }] });
   const foreign = await Note.create({ owner: stranger, title: 'Foreign archive', type: 'document' });
   const invalid = await invoke(library.bulkOrganization, { body: { action: 'archive', noteIds: [first.id, foreign.id], isArchived: true } });
   assert.equal(invalid.error?.status, 404); assert.equal((await Note.findById(first.id)).isArchived, false);
   assert.equal((await invoke(library.bulkOrganization, { body: { action: 'archive', noteIds: [first.id], isArchived: { $ne: false } } })).error?.status, 400);
   assert.ifError((await invoke(library.bulkOrganization, { body: { action: 'archive', noteIds: [first.id], isArchived: true } })).error);
   const saved = await Note.findById(first.id);
   assert.equal(saved.isArchived, true); assert.equal(saved.content, 'keep'); assert.equal(saved.sharedWith.length, 1);
   const { toNoteResponse } = await import('../dist/util/noteResponse.js');
   assert.equal(toNoteResponse(saved, stranger).isArchived, undefined);
   assert.ifError((await invoke(library.updateOrganization, { noteId: first.id, body: { notebook: '', tags: [], isArchived: false } })).error);
   assert.equal((await Note.findById(first.id)).isArchived, false);
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
  await t.test('daily notes retain identity through trash recovery and schedules run once under concurrency', async () => {
   const { default: User } = await import('../dist/models/user.model.js');
   const { default: Daily } = await import('../dist/models/dailyNote.model.js');
   const { default: Schedule } = await import('../dist/models/noteSchedule.model.js');
   const scheduling = await import('../dist/controller/noteSchedules.js');
   const { runDueSchedules } = await import('../dist/services/noteSchedules.js');
   await Promise.all([Daily.init(), Schedule.init(), Note.init()]);
   await User.create({ _id: owner, username: 'Schedule owner', email: 'schedules@example.test' });
   const template = await Note.create({ owner, title: 'Daily template', type: 'document', content: 'Plan the day', isTemplate: true, notebook: 'Journal', tags: ['daily'] });
   const results = await Promise.all([1, 2].map(() => invoke(scheduling.dailyNote, { body: { date: '2026-10-13', templateId: template.id } })));
   results.forEach(result => assert.ifError(result.error));
   assert.equal(results[0].body._id.toString(), results[1].body._id.toString());
   assert.equal(results[0].body.content, 'Plan the day'); assert.deepEqual(results[0].body.sharedWith, []);
   const dailyId = results[0].body._id.toString();
   assert.equal((await invoke(scheduling.dailyNote, { body: { date: '2026-02-31' } })).error?.status, 400);
   assert.equal((await invoke(scheduling.dailyNote, { userId: stranger, body: { date: '2026-10-13', templateId: template.id } })).error?.status, 404);
   assert.equal((await invoke(notes.deleteNote, { noteId: dailyId })).status, 204);
   assert.equal((await invoke(scheduling.dailyNote, { body: { date: '2026-10-13' } })).error?.status, 409);
   const restored = await invoke(library.recoverNote, { noteId: dailyId });
   assert.ifError(restored.error);
   assert.equal((await invoke(scheduling.dailyNote, { body: { date: '2026-10-13' } })).body._id.toString(), restored.body._id.toString());
   const created = await invoke(scheduling.createSchedule, { body: { title: 'Morning', templateId: template.id, cadence: 'daily', time: '09:00', weekday: 1 } });
   assert.ifError(created.error); const id = created.body.id;
   assert.equal((await invoke(scheduling.changeSchedule, { userId: stranger, scheduleId: id, body: { isActive: false } })).error?.status, 404);
   await Schedule.updateOne({ _id: id }, { $set: { nextRunAt: new Date('2026-10-12T09:00:00Z') } });
   const now = new Date('2026-10-13T10:00:00Z');
   await Promise.all([runDueSchedules(now), runDueSchedules(now)]);
   const saved = await Schedule.findById(id);
   assert.equal(saved.nextRunAt.toISOString(), '2026-10-14T09:00:00.000Z');
   assert.equal(await Note.countDocuments({ generationKey: 'schedule:' + id + ':2026-10-12T09:00:00.000Z' }), 1);
   assert.equal((await Note.findById(saved.lastNoteId)).content, 'Plan the day');
   assert.ifError((await invoke(scheduling.changeSchedule, { scheduleId: id, body: { isActive: false } })).error);
   const paused = await Schedule.findById(id);
   await runDueSchedules(new Date('2027-01-01T00:00:00Z'));
   assert.equal((await Schedule.findById(id)).lastNoteId.toString(), paused.lastNoteId.toString());
   assert.ifError((await invoke(scheduling.changeSchedule, { scheduleId: id, body: { isActive: true } })).error);
   await Note.updateOne({ _id: template.id }, { $set: { isTemplate: false } });
   await Schedule.updateOne({ _id: id }, { $set: { nextRunAt: now } });
   await runDueSchedules(now);
   assert.equal((await Schedule.findById(id)).isActive, false);
   assert.match((await Schedule.findById(id)).error, /Template unavailable/);
   assert.equal((await invoke(scheduling.changeSchedule, { scheduleId: id, method: 'DELETE' })).status, 204);
  });
  await t.test('quick capture is private, retries do not duplicate it, and changed retries cannot overwrite', async () => {
   const { captureNote } = await import('../dist/controller/capture.js');
   const body = { captureId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Capture', text: 'Private thought', owner: stranger, sharedWith: [{ userId: stranger }] };
   const results = await Promise.all([invoke(captureNote, { body }), invoke(captureNote, { body })]);
   results.forEach(result => assert.ifError(result.error));
   assert.equal(results[0].body._id.toString(), results[1].body._id.toString());
   assert.equal(results[0].body.owner.toString(), owner); assert.equal(results[0].body.notebook, 'Inbox');
   assert.deepEqual(results[0].body.sharedWith, []); assert.equal(results[0].body.generationKey, undefined);
   assert.equal((await invoke(captureNote, { body: { ...body, text: 'Changed retry' } })).error?.status, 409);
   const independent = await invoke(captureNote, { userId: stranger, body });
   assert.ifError(independent.error); assert.notEqual(independent.body._id.toString(), results[0].body._id.toString());
   assert.equal((await invoke(captureNote, { body: { ...body, captureId: { $ne: '' } } })).error?.status, 400);
  });
  await t.test('privacy requests are account-scoped, exports exclude credentials, and fulfillment preserves others', async () => {
   const { default: User } = await import('../dist/models/user.model.js');
   const { default: UserAuth } = await import('../dist/models/userAuth.model.js');
   const { default: PrivacyRequest } = await import('../dist/models/privacyRequest.model.js');
   const privacy = await import('../dist/controller/privacy.js');
   const { accountExport } = await import('../dist/services/accountExport.js');
   const { fulfillDeletionRequest } = await import('../dist/services/accountDeletion.js');
   await PrivacyRequest.init();
   const account = await User.create({ username: 'Privacy owner', email: 'privacy@example.test' });
   const userId = account.id;
   await UserAuth.create({ userId, password: 'password-hash-must-not-export', googleId: 'oauth-id-must-not-export' });
   const own = await Note.create({ owner: userId, title: 'Export board', type: 'whiteboard', content: '{"elements":[]}', history: [{ title: 'Prior', content: 'retained', savedAt: new Date() }], sharedWith: [{ userId: owner, permission: 'editor' }], generationKey: 'hidden-generation' });
   const foreign = await Note.create({ owner, title: 'Foreign shared', notebook: 'private-folder', content: 'foreign-private-content', sharedWith: [{ userId, permission: 'viewer' }], favoritedBy: [userId, owner] });
   const unrelated = await Note.create({ owner, title: 'Unrelated' });
   await Workspace.updateOne({ owner }, { $addToSet: { pinned: own.id }, $push: { recent: { noteId: own.id, openedAt: new Date() } } });
   await DeviceSession.create({ userId, sessionHash: 'private-session-hash', userAgent: 'Test browser', expiresAt: new Date(Date.now() + 3600000) });
   assert.equal((await invoke(privacy.changeDeletionRequest, { userId, body: { confirmation: 'wrong', owner } })).error?.status, 400);
   const requests = await Promise.all([1, 2].map(() => invoke(privacy.changeDeletionRequest, { userId, body: { confirmation: 'Privacy owner', owner } })));
   requests.forEach(result => assert.ifError(result.error));
   assert.equal(requests[0].body.id, requests[1].body.id);
   assert.equal((await invoke(privacy.getDeletionRequest, { userId: owner })).body, null);
   const lines = []; for await (const line of accountExport(userId)) lines.push(JSON.parse(line));
   assert.equal(lines.at(-1).kind, 'complete'); assert.equal(lines.at(-1).records, lines.length - 1);
   assert.equal(lines.find(line => line.kind === 'profile').data.email, 'privacy@example.test');
   assert.equal(lines.find(line => line.kind === 'ownedNote').data.history[0].content, 'retained');
   assert.equal(lines.filter(line => line.kind === 'ownedNote').length, 1);
   assert.equal(lines.find(line => line.kind === 'sharedMembership').data.permission, 'viewer');
   const serialized = JSON.stringify(lines);
   for (const secret of ['password-hash-must-not-export', 'oauth-id-must-not-export', 'hidden-generation', 'private-session-hash', 'foreign-private-content', 'private-folder']) assert.equal(serialized.includes(secret), false, secret);
   assert.equal((await invoke(privacy.changeDeletionRequest, { userId, method: 'DELETE' })).body.status, 'cancelled');
   await assert.rejects(fulfillDeletionRequest(requests[0].body.id, 'Privacy owner'), /missing or cancelled/);
   assert.equal((await invoke(privacy.changeDeletionRequest, { userId, body: { confirmation: 'Privacy owner' } })).body.status, 'pending');
   await assert.rejects(fulfillDeletionRequest(requests[0].body.id, 'wrong'), /does not match/);
   const result = await fulfillDeletionRequest(requests[0].body.id, 'Privacy owner');
   assert.equal(result.owner, userId);
   assert.equal(await User.countDocuments({ _id: userId }), 0); assert.equal(await UserAuth.countDocuments({ userId }), 0);
   assert.equal(await Note.countDocuments({ owner: userId }), 0); assert.equal(await PrivacyRequest.countDocuments({ owner: userId }), 0);
   const remaining = await Note.findById(foreign.id);
   assert.equal(remaining.content, 'foreign-private-content'); assert.deepEqual(remaining.sharedWith, []);
   assert.deepEqual(remaining.favoritedBy.map(String), [owner]);
   assert.equal((await Note.findById(unrelated.id)).updatedAt.toISOString(), unrelated.updatedAt.toISOString());
   assert.ok((await DeviceSession.findOne({ userId })).revokedAt);
   assert.equal((await Workspace.findOne({ owner })).pinned.includes(own.id), false);
  });
 } finally {
  await shutdownCollaborationServer();
  await collaborationServer.hooks("onDestroy", {});
  await mongoose.disconnect(); await replica.stop();
 }
});
