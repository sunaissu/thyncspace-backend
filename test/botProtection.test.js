import assert from 'node:assert/strict';
import test from 'node:test';
Object.assign(process.env, { CLIENT_URL: 'https://notes.example.test', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'https://api.example.test/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'disposable_access', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long', REGISTRATION_ENABLED: 'false', TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret' });
const { verifyBotToken, authPolicy, assertRegistrationEnabled } = await import('../dist/util/botProtection.js');
const success = { success: true, hostname: 'notes.example.test', action: 'register' };
test('registration policy exposes no secret and closed signup fails before account work', () => { assert.deepEqual(authPolicy(), { registrationEnabled: false, turnstileSiteKey: 'fixture-site' }); assert.throws(assertRegistrationEnabled, error => error.status === 503); });
test('bot admission checks token bounds, action and hostname and rejects provider failures', async () => {
 const good = async (url, options) => { assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.deepEqual(JSON.parse(options.body), { secret: 'fixture-secret', response: 'test-token' }); return new Response(JSON.stringify(success)); };
 await verifyBotToken('test-token', 'register', good);
 for (const token of [undefined, {}, '', 'a'.repeat(2049)]) await assert.rejects(verifyBotToken(token, 'register', () => { throw new Error('must not call'); }), error => error.status === 400);
 for (const payload of [{ ...success, success: false }, { ...success, hostname: 'attacker.test' }, { ...success, action: 'login' }, {}]) await assert.rejects(verifyBotToken('test-token', 'register', async () => new Response(JSON.stringify(payload))), error => error.status === 400);
 for (const transport of [async () => new Response('private diagnostic', { status: 503 }), async () => new Response('x'.repeat(8193)), async () => new Response('{invalid'), async () => { throw new Error('private diagnostic'); }]) await assert.rejects(verifyBotToken('test-token', 'register', transport), error => error.status === 503 && !error.message.includes('diagnostic'));
 await verifyBotToken('test-token', 'register', good);
});
