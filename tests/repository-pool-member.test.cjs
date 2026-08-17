'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildMemberMarker,
    parseGitHubRepositoryInput,
    buildV2ConfigFromLegacy,
    resolveMemberContext,
    validateMemberMarker,
    verifyGitHubRepositoryIdentity,
} = require('../repository-pool.js');

test('normalizes copied GitHub repository links without manual trimming', () => {
    assert.equal(parseGitHubRepositoryInput('https://github.com/Owner/Repo/settings?tab=access').slug, 'Owner/Repo');
    assert.equal(parseGitHubRepositoryInput('github.com/Owner/Repo/').slug, 'Owner/Repo');
    assert.equal(parseGitHubRepositoryInput('git@github.com:Owner/Repo.git').slug, 'Owner/Repo');
    assert.equal(parseGitHubRepositoryInput('Owner/Repo').slug, 'Owner/Repo');
});

function idFactory() {
    let index = 0;
    return () => `member-${++index}`;
}

function config() {
    const persisted = buildV2ConfigFromLegacy({
        repo: 'owner/archive-a',
        token: 'default-token',
        deviceId: 'device-a',
    }, { idFactory: idFactory(), githubRepositoryId: '1001' });
    persisted.repositories.push({
        repositoryId: 'repo-b',
        githubRepositoryId: '1002',
        repo: 'owner/archive-b',
        tokenOverride: 'member-token',
        membershipState: 'active',
        addedAt: '2026-07-25T00:00:00.000Z',
    });
    return {
        ...persisted,
        __poolConfig: persisted,
    };
}

test('resolves catalog and override tokens into private member contexts', () => {
    const current = config();
    const catalog = resolveMemberContext(current);
    const secondary = resolveMemberContext(current, 'repo-b');

    assert.deepEqual(catalog, {
        repositoryId: 'repo-member-1',
        githubRepositoryId: '1001',
        repo: 'owner/archive-a',
        token: 'default-token',
        membershipState: 'active',
    });
    assert.equal(secondary.token, 'member-token');
    assert.equal(secondary.repo, 'owner/archive-b');
});

test('rejects unknown members and identity mismatches', () => {
    const current = config();
    assert.throws(() => resolveMemberContext(current, 'repo-missing'), /Unknown repository member/);
    const context = resolveMemberContext(current);
    assert.throws(() => verifyGitHubRepositoryIdentity(context, { id: 9999 }), /identity mismatch/);
    assert.equal(verifyGitHubRepositoryIdentity(context, { id: 1001 }).githubRepositoryId, '1001');
});

test('bootstraps an absent GitHub ID once and rejects missing identity when disabled', () => {
    const context = { repositoryId: 'repo-a', githubRepositoryId: '', repo: 'owner/archive-a', token: 'token' };
    assert.equal(verifyGitHubRepositoryIdentity(context, { id: 1001 }).githubRepositoryId, '1001');
    assert.throws(() => verifyGitHubRepositoryIdentity(context, { id: 1001 }, { allowBootstrap: false }), /not established/);
    assert.throws(() => verifyGitHubRepositoryIdentity(context, {}), /no immutable id/);
});

test('builds and validates a pool marker without descriptor revision or token', () => {
    const context = {
        repositoryId: 'repo-a',
        githubRepositoryId: '1001',
        repo: 'owner/archive-a',
        token: 'secret-token',
    };
    const marker = buildMemberMarker({
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-a',
        context,
        createdAt: '2026-07-25T00:00:00.000Z',
    });
    assert.equal(marker.revision, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(marker, 'token'), false);
    assert.equal(validateMemberMarker(marker, {
        poolId: 'pool-a',
        repositoryId: 'repo-a',
        githubRepositoryId: '1001',
        catalogRepositoryId: 'repo-a',
    }), true);
    assert.throws(() => validateMemberMarker(marker, {
        poolId: 'pool-other',
        repositoryId: 'repo-a',
        githubRepositoryId: '1001',
        catalogRepositoryId: 'repo-a',
    }), /pool ID mismatch/);
});
