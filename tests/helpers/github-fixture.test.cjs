'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    REDACTED,
    createGitHubTransportFixture,
    createHttpError,
    createTimeoutError,
} = require('./transport.cjs');

const members = [
    {
        repositoryId: 'repo-a',
        githubRepositoryId: '1001',
        repo: 'owner/archive-a',
        token: 'secret-token-a',
    },
    {
        repositoryId: 'repo-b',
        githubRepositoryId: '1002',
        repo: 'owner/archive-b',
        token: 'secret-token-b',
    },
];

test('routes equal release IDs through independent member contexts', async () => {
    const fixture = createGitHubTransportFixture({ members });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: '/releases/42', response: { id: 42, tag_name: 'from-a' } });
    fixture.enqueue({ repositoryId: 'repo-b', endpoint: '/releases/42', response: { id: 42, tag_name: 'from-b' } });

    const [fromA, fromB] = await Promise.all([
        fixture.request(fixture.getMember('repo-a'), '/releases/42'),
        fixture.request(fixture.getMember('repo-b'), '/releases/42'),
    ]);

    assert.equal(fromA.tag_name, 'from-a');
    assert.equal(fromB.tag_name, 'from-b');
    assert.deepEqual(fixture.calls.map((call) => call.repositoryId), ['repo-a', 'repo-b']);
    assert.equal(fixture.pendingRoutes(), 0);
});

test('reproduces Contents API conflicts without network access', async () => {
    const fixture = createGitHubTransportFixture({ members });
    fixture.enqueue({
        repositoryId: 'repo-a',
        method: 'PUT',
        endpoint: '/contents/.archive-reserve.pool.json',
        error: createHttpError(409, 'sha conflict'),
    });
    fixture.enqueue({
        repositoryId: 'repo-a',
        method: 'PUT',
        endpoint: '/contents/.archive-reserve.pool.json',
        error: createHttpError(422, 'validation conflict'),
    });

    await assert.rejects(
        fixture.request(fixture.getMember('repo-a'), '/contents/.archive-reserve.pool.json', { method: 'PUT' }),
        (error) => error.statusCode === 409,
    );
    await assert.rejects(
        fixture.request(fixture.getMember('repo-a'), '/contents/.archive-reserve.pool.json', { method: 'PUT' }),
        (error) => error.statusCode === 422,
    );
});

test('models timeout and partial member availability', async () => {
    const fixture = createGitHubTransportFixture({ members });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: '/releases', response: [{ id: 1 }] });
    fixture.enqueue({ repositoryId: 'repo-b', endpoint: '/releases', error: createTimeoutError() });

    const result = await Promise.allSettled([
        fixture.request(fixture.getMember('repo-a'), '/releases'),
        fixture.request(fixture.getMember('repo-b'), '/releases'),
    ]);

    assert.equal(result[0].status, 'fulfilled');
    assert.equal(result[1].status, 'rejected');
    assert.equal(result[1].reason.code, 'ETIMEDOUT');
});

test('redacts authorization data from recorded calls', async () => {
    const fixture = createGitHubTransportFixture({ members });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: '/repo', response: { ok: true } });

    await fixture.request(fixture.getMember('repo-a'), '/repo', {
        headers: { authorization: 'Bearer secret-token-a', accept: 'application/json' },
    });

    assert.equal(fixture.calls[0].headers.authorization, REDACTED);
    assert.doesNotThrow(() => fixture.assertNoSecrets());
    assert.equal(JSON.stringify(fixture.calls).includes('secret-token-a'), false);
});

test('rejects a mismatched GitHub repository identity', async () => {
    const fixture = createGitHubTransportFixture({ members });

    await assert.rejects(
        fixture.request({ ...fixture.getMember('repo-a'), githubRepositoryId: '9999' }, '/repo'),
        /identity mismatch/,
    );
    assert.equal(fixture.calls.length, 0);
});
