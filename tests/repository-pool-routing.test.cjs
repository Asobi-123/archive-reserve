'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    aggregateMemberBackupResults,
    assertBackupRepository,
    isRetryableGitHubStatus,
    parseGraphqlReleasePage,
} = require('../repository-pool-routing.js');

test('retries transient GitHub responses without retrying permanent client errors', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableGitHubStatus(status), true);
    for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryableGitHubStatus(status), false);
});

test('parses paginated GraphQL release IDs for REST detail fallback', () => {
    assert.deepEqual(parseGraphqlReleasePage({
        data: {
            repository: {
                releases: {
                    nodes: [{ databaseId: 101 }, { databaseId: 102 }],
                    pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
                },
            },
        },
    }), { releaseIds: [101, 102], hasNextPage: true, endCursor: 'cursor-2' });
    assert.throws(() => parseGraphqlReleasePage({ errors: [{ message: 'denied' }] }), /denied/);
    assert.throws(() => parseGraphqlReleasePage({
        data: {
            repository: {
                releases: {
                    nodes: [{ databaseId: 101 }],
                    pageInfo: { hasNextPage: true, endCursor: null },
                },
            },
        },
    }), /cursor/);
});

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

test('rejects a backup whose embedded repository differs from the selected source', () => {
    assert.equal(assertBackupRepository({ repositoryId: '' }, 'repo-a'), true);
    assert.equal(assertBackupRepository({ repositoryId: 'repo-a' }, 'repo-a'), true);
    assert.throws(
        () => assertBackupRepository({ repositoryId: 'repo-b' }, 'repo-a'),
        (error) => error.statusCode === 409,
    );
});
