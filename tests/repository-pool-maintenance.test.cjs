'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    advanceCompleteScan,
    forgetDeletedOrphans,
    normalizeLedger,
    selectRetentionCandidates,
} = require('../repository-pool-maintenance.js');

test('orphan cleanup requires two complete scans separated by grace', () => {
    const first = advanceCompleteScan(null, {
        repositoryId: 'repo-a',
        orphanKeys: ['release-1:asset-1'],
        scannedAt: '2026-08-17T00:00:00.000Z',
        graceMs: 6 * 60 * 60 * 1000,
    });
    assert.deepEqual(first.eligibleKeys, []);
    const early = advanceCompleteScan(first.ledger, {
        repositoryId: 'repo-a',
        orphanKeys: ['release-1:asset-1'],
        scannedAt: '2026-08-17T05:59:59.000Z',
        graceMs: 6 * 60 * 60 * 1000,
    });
    assert.deepEqual(early.eligibleKeys, []);
    const mature = advanceCompleteScan(early.ledger, {
        repositoryId: 'repo-a',
        orphanKeys: ['release-1:asset-1'],
        scannedAt: '2026-08-17T06:00:00.000Z',
        graceMs: 6 * 60 * 60 * 1000,
    });
    assert.deepEqual(mature.eligibleKeys, ['release-1:asset-1']);
    assert.deepEqual(forgetDeletedOrphans(mature.ledger, 'repo-a', mature.eligibleKeys).members['repo-a'].orphans, {});
});

test('member ledgers are isolated and corrupt ledgers fail closed', () => {
    const first = advanceCompleteScan(null, {
        repositoryId: 'repo-a', orphanKeys: ['same'], scannedAt: '2026-08-17T00:00:00.000Z', graceMs: 0,
    });
    const second = advanceCompleteScan(first.ledger, {
        repositoryId: 'repo-b', orphanKeys: ['same'], scannedAt: '2026-08-17T01:00:00.000Z', graceMs: 0,
    });
    assert.equal(second.ledger.members['repo-a'].orphans.same.firstSeenAt, '2026-08-17T00:00:00.000Z');
    assert.equal(second.ledger.members['repo-b'].orphans.same.firstSeenAt, '2026-08-17T01:00:00.000Z');
    assert.throws(() => normalizeLedger({ version: 1, members: [] }), /Invalid/);
});

test('retention spans repositories but never crosses lanes', () => {
    const backups = [
        { releaseId: 3, repositoryId: 'repo-b', laneId: 'lane-a', automatic: false },
        { releaseId: 2, repositoryId: 'repo-a', laneId: 'lane-a', automatic: false },
        { releaseId: 1, repositoryId: 'repo-a', laneId: 'lane-other', automatic: false },
    ];
    assert.deepEqual(
        selectRetentionCandidates(backups, { automatic: false, laneId: 'lane-a', keepCount: 1 })
            .map((backup) => [backup.repositoryId, backup.releaseId]),
        [['repo-a', 2]],
    );
});
