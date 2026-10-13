import assert from 'node:assert/strict';
import test from 'node:test';
Object.assign(process.env, {
 CLIENT_URL: 'http://localhost:3000', COLLABORATION_SECRET: 'test-collaboration-secret-at-least-32-characters',
 GOOGLE_AUTH_CLIENT_ID: 'test-client', GOOGLE_AUTH_CLIENT_SECRET: 'test-secret', GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
 MONGO_CONN: 'mongodb://127.0.0.1:1', MONGO_DB_NAME: 'disposable_ai_review', SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
 AI_ACTIONS_ENABLED: 'true', OPENAI_API_KEY: 'test-key-never-a-real-key', OPENAI_AI_MODEL: 'fixture-model',
});
const { generatePassageResult, validatePassageResult } = await import('../dist/services/passageAi.js');
const { passageAction } = await import('../dist/controller/passageAi.js');
const { default: Note } = await import('../dist/models/note.model.js');
const passage = 'The beam length is 5 m.', result = { text: 'The beam is five metres long.', citations: [passage], variables: [{ name: 'Length', value: '5', unit: 'm', quote: passage }], warnings: [] };
const response = (value = result) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200 });

test('AI transport sends only the chosen passage, disables storage and has no tools', async t => {
 const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
 globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  const body = JSON.parse(options.body); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 2000); assert.equal(body.tools, undefined); assert.equal(body.previous_response_id, undefined);
  assert.deepEqual(body.input, [{ role: 'user', content: passage }]); assert.equal(body.text.format.strict, true); assert.equal(body.model, 'fixture-model'); return response();
 };
 assert.deepEqual(await generatePassageResult('variables', passage), result);
});
test('AI output rejects invented source quotes, oversized results, partial responses and provider errors', async t => {
 const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
 for (const value of [{ ...result, citations: ['invented'] }, { ...result, variables: [{ ...result.variables[0], quote: 'invented' }] }, { ...result, text: 'a'.repeat(6001) }, { ...result, variables: Array(21).fill(result.variables[0]) }, { ...result, warnings: [null] }]) assert.throws(() => validatePassageResult(value, passage));
 for (const payload of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{invalid' }] }] }]) {
  globalThis.fetch = async () => new Response(JSON.stringify(payload)); await assert.rejects(generatePassageResult('summarize', passage), /unavailable or invalid/);
 }
 globalThis.fetch = async () => new Response('Secret provider diagnostic', { status: 500 }); await assert.rejects(generatePassageResult('summarize', passage), error => error.status === 502 && !error.message.includes('Secret'));
 globalThis.fetch = async () => new Response('x'.repeat(256 * 1024 + 1)); await assert.rejects(generatePassageResult('summarize', passage), /unavailable or invalid/);
 globalThis.fetch = async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Provider text' }] }] })); await assert.rejects(generatePassageResult('summarize', passage), error => error.status === 422 && !error.message.includes('Provider text'));
 globalThis.fetch = async () => { throw new Error('A secret transport failure'); }; await assert.rejects(generatePassageResult('summarize', passage), error => !error.message.includes('secret'));
});
test('AI concurrency is bounded and released after failed requests', async t => {
 const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; }); const releases = [];
 globalThis.fetch = () => new Promise(resolve => releases.push(() => resolve(response())));
 const pending = [generatePassageResult('variables', passage), generatePassageResult('variables', passage)];
 await assert.rejects(generatePassageResult('variables', passage), error => error.status === 429);
 releases.forEach(release => release()); await Promise.all(pending); globalThis.fetch = async () => response(); assert.deepEqual(await generatePassageResult('variables', passage), result);
});
test('AI actions require current source access, exact revision and per-request consent', async t => {
 const find = Note.findOne, originalFetch = globalThis.fetch; t.after(() => { Note.findOne = find; globalThis.fetch = originalFetch; });
 const owner = '64b000000000000000000001', noteId = '64b000000000000000000002'; let available = true, calls = 0, providerCalls = 0;
 Note.findOne = filter => { assert.equal(filter._id, noteId); assert.equal(filter.type, 'document'); assert.equal(filter.status, 'active'); assert.equal(filter.$or[0].owner, owner); const query = { select: () => query, exec: async () => { calls++; return available ? { title: 'Private title not sent', content: passage + ' UNSELECTED SECRET', contentRevision: 3 } : null; } }; return query; };
 globalThis.fetch = async (_url, options) => { providerCalls++; assert.equal(options.body.includes('UNSELECTED SECRET'), false); assert.equal(options.body.includes('Private title'), false); return response(); };
 const input = { action: 'variables', start: 0, end: passage.length, excerpt: passage, expectedRevision: 3, consent: true };
 const invoke = async body => { let value, error; await passageAction({ user: { id: owner }, params: { noteId }, body }, { json(data) { value = data; } }, failure => { error = failure; }); return { value, error }; };
 for (const [change, status] of [[{ consent: false }, 400], [{ excerpt: 'x'.repeat(passage.length) }, 409], [{ expectedRevision: 2 }, 409], [{ expectedRevision: undefined }, 428], [{ start: -1 }, 400], [{ action: 'arbitrary' }, 400]]) assert.equal((await invoke({ ...input, ...change })).error.status, status);
 assert.equal(providerCalls, 0); available = false; assert.equal((await invoke(input)).error.status, 404); assert.equal(providerCalls, 0);
 available = true; const ok = await invoke(input); assert.ifError(ok.error); assert.equal(ok.value.source.noteId, noteId); assert.equal(ok.value.source.excerpt, passage); assert.equal(ok.value.source.revision, 3); assert.equal(providerCalls, 1); assert.ok(calls >= 2);
 globalThis.fetch = async () => { available = false; return response(); }; assert.equal((await invoke(input)).error.status, 404);
});
