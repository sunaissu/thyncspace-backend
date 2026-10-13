import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
test('server waits for concurrency indexes and passes the anonymous read-only deployment smoke', { timeout: 180000 }, async () => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 } }); let child, directory;
 try {
  await mkdir('test/artifacts', { recursive: true }); directory = await mkdtemp(path.resolve('test/artifacts/startup-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, CLIENT_URL: 'http://localhost:3000', HOST: '127.0.0.1', PORT: String(port), COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: replica.getUri(), MONGO_AUTH_MODE: 'password', MONGO_DB_NAME: 'disposable_startup', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long', ENVIRONMENT: 'test', REGISTRATION_ENABLED: 'false', SMTP_HOST: '', MAIL_FROM: '', REDIS_URL: '' };
  child = spawn(process.execPath, [path.resolve('dist/server.js')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Disposable API did not become ready')), 30000); child.stdout.on('data', chunk => { output += chunk; if (output.includes('Server listening')) { clearTimeout(timer); resolve(); } }); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error('Disposable API exited before readiness: ' + code)); }); });
  const result = await promisify(execFile)(process.execPath, [path.resolve('dist/smoke.js'), 'http://127.0.0.1:' + port], { cwd: directory, env, windowsHide: true, timeout: 30000 }); assert.match(result.stdout, /anonymous-access boundaries passed/);
  const policy = await (await fetch('http://127.0.0.1:' + port + '/api/auth/policy')).json(); assert.deepEqual(policy, { registrationEnabled: false, turnstileSiteKey: '' });
  const information = await (await fetch('http://127.0.0.1:' + port + '/api/service-info')).json(); assert.equal(information.status, 'operational'); assert.equal(information.supportUrl, ''); assert.equal(information.privacyUrl, ''); assert.equal(information.termsUrl, ''); assert.deepEqual(Object.keys(information).sort(), ['status', 'notice', 'supportUrl', 'privacyUrl', 'termsUrl', 'retention', 'version', 'checkedAt'].sort());
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_startup' });
  const grants = await mongoose.connection.db.collection('companiongrants').indexes(), items = await mongoose.connection.db.collection('archiveitems').indexes();
  assert.ok(grants.some(index => index.unique && index.key.owner === 1 && index.key.slot === 1)); assert.ok(grants.some(index => index.unique && index.key.tokenHash === 1)); assert.ok(items.some(index => index.unique && index.key.clientId === 1 && index.key.index === 1));
 } finally { if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; } await mongoose.disconnect(); await replica.stop(); if (directory) await rmdir(directory); }
});
