import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireMatchingAccount } from '../dist/util/auth.js';
test('stale tabs cannot reuse a request after a different account signs in', () => {
 for (const expected of ['owner', undefined]) {
  let error; requireMatchingAccount({ user: { id: 'owner' }, get: () => expected }, {}, value => { error = value; }); assert.equal(error, undefined);
 }
 let error; requireMatchingAccount({ user: { id: 'different' }, get: () => 'owner' }, {}, value => { error = value; });
 assert.equal(error.status, 409); assert.match(error.message, /account changed/);
});
