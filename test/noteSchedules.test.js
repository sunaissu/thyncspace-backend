import assert from 'node:assert/strict';
import { test } from 'node:test';
Object.assign(process.env, { CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters', GOOGLE_AUTH_CLIENT_ID: 'test', GOOGLE_AUTH_CLIENT_SECRET: 'test', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback', MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'test', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long' });
const { nextOccurrence, validateRecurrence } = await import('../dist/services/noteSchedules.js');
test('recurrence finds the next UTC occurrence across dates and week boundaries', () => {
 assert.equal(nextOccurrence({ cadence: 'daily', time: '09:30', weekday: 0 }, new Date('2028-02-28T10:00:00Z')).toISOString(), '2028-02-29T09:30:00.000Z');
 assert.equal(nextOccurrence({ cadence: 'weekly', time: '09:00', weekday: 1 }, new Date('2026-10-12T09:00:00Z')).toISOString(), '2026-10-19T09:00:00.000Z');
 assert.equal(nextOccurrence({ cadence: 'weekly', time: '09:00', weekday: 1 }, new Date('2026-10-11T10:00:00Z')).toISOString(), '2026-10-12T09:00:00.000Z');
});
test('recurrence rejects unbounded and malformed schedules', () => {
 for (const change of [{ cadence: 'minute' }, { time: '24:00' }, { weekday: 7 }, { weekday: 1.5 }, { time: { $ne: '' } }]) assert.throws(() => validateRecurrence({ cadence: 'daily', time: '09:00', weekday: 1, ...change }), { status: 400 });
});
