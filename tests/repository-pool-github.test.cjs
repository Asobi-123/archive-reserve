'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmptyDescriptor, repositoryMember } = require('../repository-pool');
const {
    DESCRIPTOR_PATH,
    MARKER_PATH,
    createRepositoryPoolStore,
} = require('../repository-pool-github');
const { createGitHubTransportFixture, createHttpError } = require('./helpers/transport.cjs');

const context = {
    repositoryId: 'repo-a',
    githubRepositoryId: '1001',
    repo: 'owner/archive-a',
    token: 'secret-token',
    membershipState: 'active',
};

function endpoint(filePath) {
    return `/repos/owner/archive-a/contents/${filePath}`;
}

function fileResponse(value, sha = 'sha-current') {
    return {
        type: 'file',
        sha,
        content: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
    };
}

function fixtureAndStore() {
    const fixture = createGitHubTransportFixture({ members: [context] });
    return {
        fixture,
        store: createRepositoryPoolStore({ request: fixture.request }),
    };
}

test('reads and writes JSON through GitHub Contents without leaking the token', async () => {
    const { fixture, store } = fixtureAndStore();
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), response: fileResponse({ revision: 1 }) });
    fixture.enqueue({
        repositoryId: 'repo-a',
        method: 'PUT',
        endpoint: endpoint(DESCRIPTOR_PATH),
        handler: ({ options }) => {
            assert.equal(options.json.sha, 'sha-current');
            assert.deepEqual(JSON.parse(Buffer.from(options.json.content, 'base64').toString('utf8')), { revision: 2 });
            return { content: { sha: 'sha-next' } };
        },
    });

    const current = await store.readJson(context, DESCRIPTOR_PATH);
    assert.deepEqual(current.value, { revision: 1 });
    const written = await store.writeJson(context, DESCRIPTOR_PATH, { revision: 2 }, { sha: current.sha });
    assert.equal(written.sha, 'sha-next');
    assert.doesNotThrow(() => fixture.assertNoSecrets());
});

test('creates a catalog marker and descriptor with migrated legacy lanes', async () => {
    const { fixture, store } = fixtureAndStore();
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(MARKER_PATH), error: createHttpError(404) });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), error: createHttpError(404) });
    let marker = null;
    let descriptor = null;
    fixture.enqueue({
        repositoryId: 'repo-a',
        method: 'PUT',
        endpoint: endpoint(MARKER_PATH),
        handler: ({ options }) => {
            marker = JSON.parse(Buffer.from(options.json.content, 'base64').toString('utf8'));
            return { content: { sha: 'sha-marker' } };
        },
    });
    fixture.enqueue({
        repositoryId: 'repo-a',
        method: 'PUT',
        endpoint: endpoint(DESCRIPTOR_PATH),
        handler: ({ options }) => {
            descriptor = JSON.parse(Buffer.from(options.json.content, 'base64').toString('utf8'));
            return { content: { sha: 'sha-descriptor' } };
        },
    });

    const result = await store.ensureCatalog({
        context,
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-a',
        backups: [{
            device: { id: 'device-a', name: 'MacBook' },
            backupRoot: { root: 'default-user' },
            createdAt: '2026-07-24T00:00:00.000Z',
        }],
        now: '2026-07-25T00:00:00.000Z',
    });

    assert.equal(marker.poolId, 'pool-a');
    assert.equal(marker.revision, undefined);
    assert.equal(descriptor.members[0].membershipState, 'active');
    assert.equal(Object.values(descriptor.backupLanes)[0].segments[0].startedAt, null);
    assert.equal(result.sha, 'sha-descriptor');
});

test('adopts an existing catalog by immutable GitHub identity', async () => {
    const { fixture, store } = fixtureAndStore();
    const descriptor = createEmptyDescriptor({ poolId: 'pool-remote', catalogRepositoryId: 'repo-remote' });
    descriptor.members = [repositoryMember({
        repositoryId: 'repo-remote',
        githubRepositoryId: '1001',
        repo: 'owner/archive-renamed',
        addedAt: '2026-07-20T00:00:00.000Z',
    })];
    const marker = {
        version: 1,
        poolId: 'pool-remote',
        repositoryId: 'repo-remote',
        githubRepositoryId: '1001',
        catalogRepositoryId: 'repo-remote',
        createdAt: '2026-07-20T00:00:00.000Z',
    };
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(MARKER_PATH), response: fileResponse(marker, 'sha-marker') });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), response: fileResponse(descriptor, 'sha-descriptor') });

    const result = await store.ensureCatalog({ context, poolId: 'pool-local', catalogRepositoryId: 'repo-a' });
    assert.equal(result.adopted, true);
    assert.equal(result.descriptor.poolId, 'pool-remote');
    assert.equal(fixture.calls.filter((call) => call.method === 'PUT').length, 0);
});

test('store-level descriptor update retries a Contents 409 with the newest sha', async () => {
    const { fixture, store } = fixtureAndStore();
    const initial = createEmptyDescriptor({ poolId: 'pool-a', catalogRepositoryId: 'repo-a' });
    initial.members = [repositoryMember(context)];
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), response: fileResponse(initial, 'sha-1') });
    fixture.enqueue({ repositoryId: 'repo-a', method: 'PUT', endpoint: endpoint(DESCRIPTOR_PATH), error: createHttpError(409) });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), response: fileResponse({ ...initial, revision: 2 }, 'sha-2') });
    fixture.enqueue({
        repositoryId: 'repo-a',
        method: 'PUT',
        endpoint: endpoint(DESCRIPTOR_PATH),
        handler: ({ options }) => {
            assert.equal(options.json.sha, 'sha-2');
            return { content: { sha: 'sha-3' } };
        },
    });

    const result = await store.updateDescriptor(context, {
        type: 'add-member',
        member: { repositoryId: 'repo-b', githubRepositoryId: '1002', repo: 'owner/archive-b' },
    }, { now: () => '2026-07-25T00:00:00.000Z' });
    assert.equal(result.attempts, 2);
    assert.equal(result.sha, 'sha-3');
});

test('catalog creation recovers when another client wins the descriptor race', async () => {
    const { fixture, store } = fixtureAndStore();
    const remote = createEmptyDescriptor({ poolId: 'pool-a', catalogRepositoryId: 'repo-a' });
    remote.members = [repositoryMember(context)];
    const marker = {
        version: 1,
        poolId: 'pool-a',
        repositoryId: 'repo-a',
        githubRepositoryId: '1001',
        catalogRepositoryId: 'repo-a',
        createdAt: '2026-07-25T00:00:00.000Z',
    };
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(MARKER_PATH), error: createHttpError(404) });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), error: createHttpError(404) });
    fixture.enqueue({ repositoryId: 'repo-a', method: 'PUT', endpoint: endpoint(MARKER_PATH), response: { content: { sha: 'marker-sha' } } });
    fixture.enqueue({ repositoryId: 'repo-a', method: 'PUT', endpoint: endpoint(DESCRIPTOR_PATH), error: createHttpError(422) });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), response: fileResponse(remote, 'remote-sha') });
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(MARKER_PATH), response: fileResponse(marker, 'marker-sha') });

    const result = await store.ensureCatalog({ context, poolId: 'pool-a', catalogRepositoryId: 'repo-a' });
    assert.equal(result.sha, 'remote-sha');
    assert.equal(result.descriptor.poolId, 'pool-a');
});

test('mirror sync isolates one failed member and repairs stale revisions', async () => {
    const secondary = {
        repositoryId: 'repo-b',
        githubRepositoryId: '1002',
        repo: 'owner/archive-b',
        token: 'member-token',
        membershipState: 'active',
    };
    const fixture = createGitHubTransportFixture({ members: [context, secondary] });
    const store = createRepositoryPoolStore({ request: fixture.request });
    const descriptor = createEmptyDescriptor({ poolId: 'pool-a', catalogRepositoryId: 'repo-a' });
    descriptor.revision = 4;
    descriptor.members = [repositoryMember(context), repositoryMember(secondary)];
    fixture.enqueue({ repositoryId: 'repo-a', endpoint: endpoint(DESCRIPTOR_PATH), response: fileResponse(descriptor, 'sha-a') });
    fixture.enqueue({
        repositoryId: 'repo-b',
        endpoint: '/repos/owner/archive-b/contents/.archive-reserve.pool.json',
        error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    });

    const partial = await store.syncDescriptorMirrors([context, secondary], descriptor);
    assert.deepEqual(partial.map((item) => item.synced), [true, false]);

    const stale = { ...descriptor, revision: 3 };
    fixture.enqueue({
        repositoryId: 'repo-b',
        endpoint: '/repos/owner/archive-b/contents/.archive-reserve.pool.json',
        response: fileResponse(stale, 'sha-b-old'),
    });
    fixture.enqueue({
        repositoryId: 'repo-b',
        method: 'PUT',
        endpoint: '/repos/owner/archive-b/contents/.archive-reserve.pool.json',
        handler: ({ options }) => {
            assert.equal(options.json.sha, 'sha-b-old');
            return { content: { sha: 'sha-b-new' } };
        },
    });
    const repaired = await store.syncDescriptorMirror(secondary, descriptor);
    assert.equal(repaired.synced, true);
    assert.equal(repaired.changed, true);
    assert.equal(repaired.sha, 'sha-b-new');
});
