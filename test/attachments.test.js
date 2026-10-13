import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';

Object.assign(process.env, { CLIENT_URL: 'http://localhost:3000', GOOGLE_AUTH_CLIENT_ID: 'fixture', GOOGLE_AUTH_CLIENT_SECRET: 'fixture', GOOGLE_CALLBACK_URL: 'http://localhost:5000/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'attachment_fixture', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long' });
const { validateAttachment } = await import('../dist/services/attachments.js');

test('attachment admission rejects active formats, false MIME types, malformed data and paths', async () => {
 const body = { name: 'safe.txt', mime: 'text/plain', data: Buffer.from('Safe text').toString('base64') };
 assert.equal((await validateAttachment(body)).data.toString(), 'Safe text');
 for (const patch of [{ name: '../safe.txt' }, { name: 'bad\r\nname.txt' }, { mime: 'text/html' }, { mime: 'image/svg+xml' }, { mime: 'image/png' }, { data: 'AAAA===' }, { data: Buffer.from([0xc0, 0xaf]).toString('base64') }, { data: Buffer.from('null\0text').toString('base64') }]) await assert.rejects(validateAttachment({ ...body, ...patch }));
 await assert.rejects(validateAttachment({ ...body, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }), /2 MiB/);
});
test('image attachments are decoded, oriented, stripped of metadata, and pixel-bounded', async () => {
 const input = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#336699' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
 const stored = await validateAttachment({ name: 'photo.jpg', mime: 'image/jpeg', data: input.toString('base64') });
 const metadata = await sharp(stored.data).metadata();
 assert.equal(metadata.width, 20); assert.equal(metadata.height, 30); assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
 const excessive = await sharp({ create: { width: 4000, height: 3001, channels: 3, background: '#fff' } }).png().toBuffer();
 await assert.rejects(validateAttachment({ name: 'oversized.png', mime: 'image/png', data: excessive.toString('base64') }), /12 million/);
});
