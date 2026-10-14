import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
const secret = 'test-collaboration-protocol-secret-at-least-32-characters';
Object.assign(process.env, {
 CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: secret,
 GOOGLE_AUTH_CLIENT_ID: 'test-client', GOOGLE_AUTH_CLIENT_SECRET: 'test-secret',
 GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
 MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'protocol_test',
 SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
});
const { createCollaborationToken, verifyCollaborationToken } = await import('../dist/util/collaborationToken.js');
const { createRealtimeToken } = await import('../dist/controller/notes.js');
const { default: Note } = await import('../dist/models/note.model.js');
const noteId = '64b000000000000000000001', owner = '64b000000000000000000002';
const sessionHash = 'a'.repeat(64);

test('current collaboration tokens bind the protocol, owner, note and session', () => {
 const payload = verifyCollaborationToken(createCollaborationToken(noteId, owner, sessionHash));
 assert.equal(payload.protocol, 1);
 assert.equal(payload.noteId, noteId);
 assert.equal(payload.userId, owner);
 assert.equal(payload.sessionHash, sessionHash);
});

test('validly signed legacy and incompatible tokens cannot reconnect', () => {
 for (const protocol of [undefined, 0, 2, '1']) {
  const encoded = Buffer.from(JSON.stringify({ protocol, noteId, userId: owner, sessionHash, expiresAt: Date.now() + 60000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  assert.throws(() => verifyCollaborationToken(encoded + '.' + signature));
 }
});

test('token issuance rejects incompatible clients before reading note data', async () => {
 const original = Note.findOne;
 let reads = 0;
 Note.findOne = () => { reads++; return { select() { return { exec: async () => ({ owner, sharedWith: [] }) }; } }; };
 const invoke = async body => {
  const result = {};
  await createRealtimeToken({ params: { noteId }, user: { id: owner }, sessionID: 'protocol-test-device', body },
   { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } },
   error => { result.error = error; });
  return result;
 };
 try {
  for (const body of [undefined, {}, { protocol: 0 }, { protocol: '1' }, { protocol: 2 }]) {
   const result = await invoke(body);
   assert.equal(result.error?.status, 409);
   assert.match(result.error.message, /Refresh/);
  }
  assert.equal(reads, 0);
  const result = await invoke({ protocol: 1 });
  assert.equal(result.status, 200);
  assert.equal(reads, 1);
  assert.equal(verifyCollaborationToken(result.body.token).protocol, 1);
 } finally { Note.findOne = original; }
});
