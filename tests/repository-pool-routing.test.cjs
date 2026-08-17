'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateMemberBackupResults } = require('../repository-pool-routing.js');

test('aggregates equal release IDs without losing repository identity', () => {
    const result = aggregateMemberBackupResults([
        {
            repositoryId: 'repo-a',
            repo: 'owner/a',
            readable: true,
            lastValidatedAt: '2026-08-17T00:00:00.000Z',
            backups: [{ releaseId: 7, createdAt: '2026-08-16T00:00:00.000Z' }],
        },
        {
            repositoryId: 'repo-b',
            repo: 'owner/b',
            readable: true,
            lastValidatedAt: '2026-08-17T00:00:01.000Z',
            backups: [{ releaseId: 7, createdAt: '2026-08-17T00:00:00.000Z' }],
        },
    ], { checkedAt: '2026-08-17T00:00:02.000Z' });
    assert.deepEqual(result.backups.map((backup) => [backup.repositoryId, backup.releaseId]), [
        ['repo-b', 7],
        ['repo-a', 7],
    ]);
    assert.equal(result.partial, false);
});

test('reports failed members and stale descriptors as partial state', () => {
    const descriptorError = new Error('catalog timeout');
    const result = aggregateMemberBackupResults([
        {
            repositoryId: 'repo-a', repo: 'owner/a', readable: true, backups: [],
        },
        {
            repositoryId: 'repo-b', repo: 'owner/b', readable: false, error: 'timeout', backups: [],
        },
    ], { descriptorStale: true, descriptorError });
    assert.equal(result.partial, true);
    assert.equal(result.members[1].error, 'timeout');
    assert.equal(result.freshness.stale, true);
    assert.equal(result.freshness.error, 'catalog timeout');
});
