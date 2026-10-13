import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEmail } from '../dist/util/validation.js';

test('email addresses cannot smuggle mailbox lists, headers, or invalid domains into SMTP', () => {
 assert.equal(validateEmail(' Person+notes@Example.COM '), 'person+notes@example.com');
 assert.equal(validateEmail("o'connor@example.test"), "o'connor@example.test");
 for (const address of ['a,b@example.test', 'a;b@example.test', 'Name<person@example.test>', 'person@example.test\r\nBcc: other@example.test', 'a\0b@example.test', 'a@example..test', 'a@-example.test', 'a..b@example.test', '.a@example.test', 'a.@example.test']) assert.throws(() => validateEmail(address), /valid email/);
});
