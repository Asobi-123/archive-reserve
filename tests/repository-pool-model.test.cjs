'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    addDeviceIdAlias,
    adoptRemoteDescriptor,
    assertTokenFreeDescriptor,
    buildLegacyLaneInventory,
    buildV2ConfigFromLegacy,
    createEmptyDescriptor,
    findLane,
    normalizeV2Config,
    serializeRuntimeConfig,
    toRuntimeConfig,
    updateRuntimeMemberCredential,
    writeJsonAtomically,
} = require('../repository-pool.js');

function idFactory() {
    let index = 0;
    return () => `test-${++index}`;
}

test('migrates a v1 config into one stable catalog member', () => {
    const next = buildV2ConfigFromLegacy({
        repo: 'owner/archive-a',
        token: 'secret-token',
        backupRoot: 'default-user',
        deviceId: 'device-a',
        deviceName: 'MacBook',
        autoBackupEnabled: true,
    }, {
        idFactory: idFactory(),
        githubRepositoryId: '1001',
        now: '2026-07-25T00:00:00.000Z',
    });

    assert.equal(next.configVersion, 2);
    assert.equal(next.poolId, 'pool-test-2');
    assert.equal(next.catalogRepositoryId, 'repo-test-1');
    assert.equal(next.defaultToken, 'secret-token');
    assert.equal(next.repositories.length, 1);
    assert.equal(next.repositories[0].githubRepositoryId, '1001');
    assert.equal(next.repositories[0].repo, 'owner/archive-a');
    assert.equal(next.repositories[0].tokenOverride, undefined);
    assert.equal(next.backupRoot, 'default-user');
    assert.equal(next.autoBackupEnabled, true);
});

test('normalizes only a valid v2 config and rejects catalog drift', () => {
    const config = normalizeV2Config({
        configVersion: 2,
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-a',
        defaultToken: 'secret',
        repositories: [{
            repositoryId: 'repo-a',
            githubRepositoryId: 1001,
            repo: 'owner/archive-a',
        }],
    });
    assert.equal(config.repositories[0].githubRepositoryId, '1001');
    assert.throws(() => normalizeV2Config({
        configVersion: 2,
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-missing',
        repositories: [],
    }), /Catalog repository/);
});

test('preserves validated member state across config normalization', () => {
    const lastKnownState = {
        readable: false,
        catalogSynced: false,
        writeEligible: false,
        lastValidatedAt: '2026-08-17T00:00:00.000Z',
    };
    const config = normalizeV2Config({
        configVersion: 2,
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-a',
        defaultToken: 'secret',
        repositories: [{
            repositoryId: 'repo-a',
            githubRepositoryId: '1001',
            repo: 'owner/archive-a',
            lastKnownState,
        }],
    });
    assert.deepEqual(config.repositories[0].lastKnownState, lastKnownState);
    assert.notEqual(config.repositories[0].lastKnownState, lastKnownState);
});

test('projects v2 config to legacy runtime fields without persisting legacy token fields', () => {
    const persisted = buildV2ConfigFromLegacy({
        repo: 'owner/archive-a',
        token: 'secret-token',
        deviceId: 'device-a',
    }, { idFactory: idFactory(), githubRepositoryId: '1001' });
    const runtime = toRuntimeConfig(persisted);
    assert.equal(runtime.repo, 'owner/archive-a');
    assert.equal(runtime.token, 'secret-token');
    runtime.repo = 'owner/archive-renamed';
    runtime.token = 'new-secret-token';
    const next = serializeRuntimeConfig(runtime);
    assert.equal(next.defaultToken, 'new-secret-token');
    assert.equal(next.repositories[0].repo, 'owner/archive-renamed');
    assert.equal(Object.prototype.hasOwnProperty.call(next, 'repo'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(next, 'token'), false);
});

test('persists updated catalog and member credentials without stale overrides', () => {
    const persisted = buildV2ConfigFromLegacy({ repo: 'owner/archive-a', token: 'old-default' }, {
        idFactory: idFactory(),
        githubRepositoryId: '1001',
    });
    const catalogId = persisted.catalogRepositoryId;
    persisted.repositories[0].tokenOverride = 'old-override';
    persisted.repositories[0].lastKnownState = { readable: false };
    persisted.repositories.push({
        repositoryId: 'repo-b',
        githubRepositoryId: '1002',
        repo: 'owner/archive-b',
        membershipState: 'active',
    });
    const runtime = toRuntimeConfig(persisted);

    updateRuntimeMemberCredential(runtime, catalogId, 'new-default');
    updateRuntimeMemberCredential(runtime, 'repo-b', 'repo-b-token');
    const saved = serializeRuntimeConfig(runtime);

    assert.equal(saved.defaultToken, 'new-default');
    assert.equal(saved.repositories[0].tokenOverride, undefined);
    assert.equal(saved.repositories[0].lastKnownState, undefined);
    assert.equal(saved.repositories[1].tokenOverride, 'repo-b-token');
});

test('adopts every remote member while preserving local token overrides', () => {
    const persisted = buildV2ConfigFromLegacy({ repo: 'owner/archive-a', token: 'default-token' }, {
        idFactory: idFactory(),
        githubRepositoryId: '1001',
    });
    persisted.repositories[0].tokenOverride = 'catalog-override';
    const runtime = toRuntimeConfig(persisted);
    const descriptor = createEmptyDescriptor({ poolId: 'pool-remote', catalogRepositoryId: 'repo-remote-a' });
    descriptor.members = [
        { repositoryId: 'repo-remote-a', githubRepositoryId: '1001', repo: 'owner/archive-a', membershipState: 'active' },
        { repositoryId: 'repo-remote-b', githubRepositoryId: '1002', repo: 'owner/archive-b', membershipState: 'active' },
    ];
    adoptRemoteDescriptor(runtime, descriptor, '1001');
    assert.equal(runtime.catalogRepositoryId, 'repo-remote-a');
    assert.equal(runtime.repositories.length, 2);
    assert.equal(runtime.repositories[0].tokenOverride, 'catalog-override');
    assert.equal(runtime.repositories[1].tokenOverride, undefined);
});

test('adopts an existing pool from a non-catalog member without changing the catalog address', () => {
    const local = buildV2ConfigFromLegacy({ repo: 'owner/archive-b', token: 'shared-token' }, {
        idFactory: idFactory(),
        githubRepositoryId: '1002',
    });
    const runtime = toRuntimeConfig(local);
    const descriptor = createEmptyDescriptor({ poolId: 'pool-remote', catalogRepositoryId: 'repo-remote-a' });
    descriptor.members = [
        { repositoryId: 'repo-remote-a', githubRepositoryId: '1001', repo: 'owner/archive-a', membershipState: 'active' },
        { repositoryId: 'repo-remote-b', githubRepositoryId: '1002', repo: 'owner/archive-b', membershipState: 'active' },
    ];

    adoptRemoteDescriptor(runtime, descriptor, '1002');
    const saved = serializeRuntimeConfig(runtime);
    assert.equal(runtime.repo, 'owner/archive-a');
    assert.equal(saved.repositories.find((member) => member.repositoryId === 'repo-remote-a').repo, 'owner/archive-a');
    assert.equal(saved.repositories.find((member) => member.repositoryId === 'repo-remote-b').repo, 'owner/archive-b');
});

test('builds legacy lanes conservatively and preserves a negative-infinity segment', () => {
    const backups = [
        { device: { id: 'device-a', name: 'MacBook' }, backupRoot: { root: 'default-user' } },
        { device: { id: 'device-a', name: 'MacBook' }, backupRoot: { root: 'default-user' } },
        { device: { id: 'device-b', name: 'MacBook' }, backupRoot: { root: 'default-user' } },
        { device: { id: '', name: 'Tablet' }, backupRoot: { root: 'other-user' } },
        { device: { id: '', name: 'Tablet' }, backupRoot: { root: 'other-user' } },
        { device: { id: '', name: '' }, backupRoot: { root: 'default-user' } },
        { createdAt: 'not-a-date', device: { id: 'bad-time', name: 'Clock' }, backupRoot: { root: 'default-user' } },
    ];
    const result = buildLegacyLaneInventory(backups, {
        idFactory: idFactory(),
        repositoryId: 'repo-a',
    });

    assert.equal(Object.keys(result.lanes).length, 2);
    assert.equal(result.unresolved.length, 4);
    for (const lane of Object.values(result.lanes)) {
        assert.equal(lane.segments[0].startedAt, null);
        assert.equal(lane.segments[0].repositoryId, 'repo-a');
    }
});

test('resolves exact device IDs before unique device-name fallback', () => {
    const inventory = buildLegacyLaneInventory([
        { device: { id: 'device-a', name: 'MacBook' }, backupRoot: { root: 'default-user' } },
        { device: { id: 'device-b', name: 'MacBook' }, backupRoot: { root: 'other-user' } },
    ], { idFactory: idFactory() });
    const descriptor = createEmptyDescriptor({ poolId: 'pool-a', catalogRepositoryId: 'repo-a' });
    descriptor.backupLanes = inventory.lanes;

    const exact = findLane(descriptor, { backupRoot: 'default-user', deviceId: 'device-a', deviceName: 'Other' });
    assert.equal(exact.match, 'device-id');
    const fallback = findLane(descriptor, { backupRoot: 'default-user', deviceId: 'new-device', deviceName: 'MacBook' });
    assert.equal(fallback.match, 'device-name');
});

test('adds a device ID alias only once and never across lanes', () => {
    const inventory = buildLegacyLaneInventory([
        { device: { id: 'device-a', name: 'MacBook' }, backupRoot: { root: 'default-user' } },
        { device: { id: 'device-b', name: 'Tablet' }, backupRoot: { root: 'other-user' } },
    ], { idFactory: idFactory() });
    const descriptor = createEmptyDescriptor({ poolId: 'pool-a', catalogRepositoryId: 'repo-a' });
    descriptor.backupLanes = inventory.lanes;
    const laneId = Object.keys(descriptor.backupLanes)[0];
    const next = addDeviceIdAlias(descriptor, laneId, 'old-device-a');
    assert.deepEqual(next.backupLanes[laneId].identity.deviceIdAliases, ['old-device-a']);
    assert.equal(findLane(next, {
        backupRoot: next.backupLanes[laneId].identity.backupRoot,
        deviceId: 'old-device-a',
        deviceName: 'renamed device',
    }).laneId, laneId);
    assert.deepEqual(addDeviceIdAlias(next, laneId, 'old-device-a'), next);
    const otherLaneId = Object.keys(next.backupLanes).find((candidate) => candidate !== laneId);
    assert.throws(() => addDeviceIdAlias(next, otherLaneId, 'old-device-a'), /already belongs to another lane/);
});

test('atomic JSON writes keep the previous file as a recoverable backup', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-reserve-model-'));
    const filePath = path.join(directory, 'config.json');
    await writeJsonAtomically(filePath, { version: 1 });
    await writeJsonAtomically(filePath, { version: 2 });

    assert.deepEqual(JSON.parse(await fsp.readFile(filePath, 'utf8')), { version: 2 });
    assert.deepEqual(JSON.parse(await fsp.readFile(`${filePath}.bak`, 'utf8')), { version: 1 });
    const names = await fsp.readdir(directory);
    assert.deepEqual(names.sort(), ['config.json', 'config.json.bak']);
    await fsp.rm(directory, { recursive: true, force: true });
});

test('atomic JSON write failures do not replace the target or leave temp files', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-reserve-model-'));
    const filePath = path.join(directory, 'config.json');
    await writeJsonAtomically(filePath, { version: 1 });
    await assert.rejects(writeJsonAtomically(filePath, { invalid: 1n }), /BigInt/);
    assert.deepEqual(JSON.parse(await fsp.readFile(filePath, 'utf8')), { version: 1 });
    assert.deepEqual((await fsp.readdir(directory)).sort(), ['config.json', 'config.json.bak']);
    await fsp.rm(directory, { recursive: true, force: true });
});

test('descriptor token validation rejects secrets before remote serialization', () => {
    assert.doesNotThrow(() => assertTokenFreeDescriptor({ poolId: 'pool-a', members: [] }));
    assert.throws(() => assertTokenFreeDescriptor({ token: 'secret-token' }), /forbidden token field/);
});
