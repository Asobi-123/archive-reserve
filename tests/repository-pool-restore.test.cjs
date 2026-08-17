'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertStagingComplete, collectRequiredDirectories } = require('../repository-pool-restore.js');

test('restore staging includes explicit and file parent directories', () => {
    assert.deepEqual(collectRequiredDirectories({
        directories: [{ path: 'empty' }],
        files: [{ path: 'chats/character/session.json' }],
    }), ['empty', 'chats', 'chats/character']);
});

test('missing staged files stop restore before the commit phase', () => {
    assert.equal(assertStagingComplete([]), true);
    assert.throws(
        () => assertStagingComplete([{ path: 'missing/file.json' }]),
        (error) => error.statusCode === 409 && error.message.includes('missing/file.json'),
    );
});
