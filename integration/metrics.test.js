import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import User from '../dist/models/user.model.js';
import MetricDay from '../dist/models/metricDay.model.js';
import { getMetricsConsent, setMetricsConsent, recordMetric, aggregateMetrics } from '../dist/services/productMetrics.js';
import { observeNoteMetrics } from '../dist/controller/productMetrics.js';
test('usage counts require consent, omit content, serialize opt-out and aggregate without identities', { timeout: 180000 }, async () => {
 const replica = await MongoMemoryReplSet.create({ binary: { version: '8.0.16' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
 try {
  await mongoose.connect(replica.getUri(), { dbName: 'disposable_metrics' }); await Promise.all([User.init(), MetricDay.init()]);
  const user = await User.create({ username: 'Private Metrics Name', email: 'private@example.test' }), other = await User.create({ username: 'Other Metrics Name', email: 'other@example.test' });
  assert.deepEqual(await getMetricsConsent(user.id), { enabled: false, revision: 0 }); await recordMetric(user.id, 'note_created'); assert.equal(await MetricDay.countDocuments(), 0);
  await assert.rejects(setMetricsConsent(user.id, 'true', 0), error => error.status === 400); await assert.rejects(setMetricsConsent(user.id, true), error => error.status === 428);
  assert.deepEqual(await setMetricsConsent(user.id, true, 0), { enabled: true, revision: 1 }); await assert.rejects(setMetricsConsent(user.id, false, 0), error => error.status === 409);
  const dates = ['2026-09-01', '2026-09-02', '2026-09-08', '2026-09-29'];
  for (const date of dates) await recordMetric(user.id, 'note_opened', new Date(date));
  await Promise.all(Array.from({ length: 8 }, () => recordMetric(user.id, 'note_saved', new Date(dates[0]))));
  const rows = await MetricDay.find().lean(), text = JSON.stringify(rows), subject = rows[0].subject;
  for (const privateValue of [user.id, user.username, 'private@example.test', 'calculator']) assert.equal(text.includes(privateValue), false);
  assert.equal(rows.find(row => row.day === dates[0]).counters.note_saved, 8);
  await assert.rejects(recordMetric(user.id, 'calculator_opened'), /Unknown/);
  const report = await aggregateMetrics(new Date('2026-10-01')); assert.equal(report.participants, 1); assert.equal(report.events.note_saved, 8); assert.deepEqual(report.cohorts[7], { eligible: 1, returned: 1 }); assert.equal(JSON.stringify(report).includes(subject), false);
  await MetricDay.updateOne({ subject, day: dates[0] }, { $set: { total: 1000 } }); await recordMetric(user.id, 'note_saved', new Date(dates[0])); assert.equal((await MetricDay.findOne({ subject, day: dates[0] })).total, 1000);
  await setMetricsConsent(other.id, true, 0); await recordMetric(other.id, 'note_created');
  await Promise.all([recordMetric(user.id, 'note_created'), setMetricsConsent(user.id, false, 1)]); assert.equal(await MetricDay.countDocuments({ subject }), 0); assert.equal(await MetricDay.countDocuments(), 1);
  await recordMetric(user.id, 'note_created'); assert.equal(await MetricDay.countDocuments({ subject }), 0);
  await setMetricsConsent(user.id, true, 2); await recordMetric(user.id, 'note_created'); assert.notEqual((await User.findById(user.id).select('+metricsSubject')).metricsSubject, subject);
  const profile = JSON.stringify(await User.findById(user.id)); assert.equal(profile.includes('metricsSubject'), false); assert.equal(profile.includes('metricsEnabled'), false);
  const req = { method: 'GET', route: { path: '/:noteId' }, user: { id: user.id }, body: { title: 'NEVER COPY', content: 'NEVER COPY' }, params: { noteId: 'NEVER COPY' } }, res = new EventEmitter(); res.statusCode = 200;
  observeNoteMetrics(req, res, () => {}); res.emit('finish');
  for (let count = 0; count < 100 && !await MetricDay.exists({ 'counters.note_opened': { $gt: 0 } }); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(await MetricDay.find().lean()).includes('NEVER COPY'), false); assert.ok(await MetricDay.exists({ 'counters.note_opened': { $gt: 0 } }));
  assert.equal((await aggregateMetrics(new Date('2027-10-01'))).participants, 0);
 } finally { await mongoose.disconnect(); await replica.stop(); }
});
