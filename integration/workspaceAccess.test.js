import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
Object.assign(process.env, { CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'disposable_verification', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long', REQUIRE_VERIFIED_EMAIL: 'true', SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'test@example.test' });
const { default: mongoose } = await import('mongoose');
const { default: User } = await import('../dist/models/user.model.js');
const { default: Note } = await import('../dist/models/note.model.js');
const { default: Device } = await import('../dist/models/deviceSession.model.js');
const { default: Grant } = await import('../dist/models/companionGrant.model.js');
const { assertWorkspaceAccess } = await import('../dist/util/workspaceAccess.js');
const { assertActiveDeviceSession } = await import('../dist/util/deviceSessions.js');
const { loadSessionIdentity } = await import('../dist/util/sessionIdentity.js');
const companion = await import('../dist/services/companion.js');
const { shutdownCollaborationServer } = await import('../dist/collaboration/server.js');
test('verification gates workspace, live and companion access while preserving the account session', { timeout: 180000 }, async () => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 } });
 try {
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_verification' }); await Promise.all([User.init(), Note.init(), Device.init(), Grant.init()]);
  const user = await User.create({ username: 'Unverified', email: 'person@example.test' }), note = await Note.create({ owner: user.id, title: 'Existing document' }), sessionHash = 'b'.repeat(64);
  await Device.create({ userId: user.id, sessionHash, expiresAt: new Date(Date.now() + 3600000) });
  assert.ok(await loadSessionIdentity({ id: user.id, version: 0 })); await assert.rejects(assertWorkspaceAccess(user.id), error => error.status === 403); await assert.rejects(assertActiveDeviceSession(sessionHash, user.id), error => error.status === 401);
  const input = { clientId: randomUUID(), consent: true, name: 'Desktop', noteIds: [note.id], attachments: false };
  await assert.rejects(companion.createCompanionGrant(user.id, input), error => error.status === 401);
  await User.updateOne({ _id: user.id }, { $set: { emailVerifiedAt: new Date() } }); await assertWorkspaceAccess(user.id); await assertActiveDeviceSession(sessionHash, user.id);
  const grant = await companion.createCompanionGrant(user.id, input); assert.equal((await companion.authenticateCompanion('Bearer ' + grant.token)).owner, user.id);
  await User.updateOne({ _id: user.id }, { $set: { emailVerifiedAt: null } }); await assert.rejects(companion.authenticateCompanion('Bearer ' + grant.token), error => error.status === 401); assert.ok(await loadSessionIdentity({ id: user.id, version: 0 }));
 } finally { await shutdownCollaborationServer(); await mongoose.disconnect(); await replica.stop(); }
});
