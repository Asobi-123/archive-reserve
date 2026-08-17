'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    applyDescriptorOperation,
    createEmptyDescriptor,
    createLaneReservation,
    deriveMemberCapabilities,
    repositoryMember,
    resolveBackupReservation,
    resolveReadableMember,
    resolveWriteEligibleMember,
    assertReservationCurrent,
    updateDescriptorWithCas,
} = require('../repository-pool.js');

function descriptor() {
    return {
        ...createEmptyDescriptor({ poolId: 'pool-a', catalogRepositoryId: 'repo-a' }),
        members: [repositoryMember({
            repositoryId: 'repo-a',
            githubRepositoryId: '1001',
            repo: 'owner/archive-a',
            addedAt: '2026-07-25T00:00:00.000Z',
        })],
        backupLanes: {
            'lane-a': {
                identity: {
                    backupRoot: 'default-user',
                    deviceId: 'device-a',
                    deviceIdAliases: [],
                    deviceNameKeyHash: 'sha256:name',
                },
                segments: [{
                    segmentId: 'segment-a',
                    repositoryId: 'repo-a',
                    startedAt: null,
                    reason: 'legacy-initial',
                }],
            },
        },
    };
}

test('member admission is pending, idempotent, and identity-safe', () => {
    const pending = applyDescriptorOperation(descriptor(), {
        type: 'add-member',
        member: {
            repositoryId: 'repo-b',
            githubRepositoryId: '1002',
            repo: 'owner/archive-b',
            addedAt: '2026-07-25T00:00:00.000Z',
        },
    }, { now: '2026-07-25T00:00:01.000Z' });
    assert.equal(pending.changed, true);
    assert.equal(pending.descriptor.members[1].membershipState, 'pending');
    const retry = applyDescriptorOperation(pending.descriptor, {
        type: 'add-member',
        member: {
            repositoryId: 'repo-b',
            githubRepositoryId: '1002',
            repo: 'owner/archive-b',
            addedAt: '2026-07-25T00:00:00.000Z',
        },
    });
    assert.equal(retry.changed, false);
    assert.throws(() => applyDescriptorOperation(pending.descriptor, {
        type: 'add-member',
        member: { repositoryId: 'repo-b', githubRepositoryId: '9999', repo: 'owner/other' },
    }), (error) => error.statusCode === 409);
});

test('pending admission activates or cancels only under its safety rules', () => {
    const added = applyDescriptorOperation(descriptor(), {
        type: 'add-member',
        member: { repositoryId: 'repo-b', githubRepositoryId: '1002', repo: 'owner/archive-b' },
    }).descriptor;
    const active = applyDescriptorOperation(added, { type: 'activate-member', repositoryId: 'repo-b' }).descriptor;
    assert.equal(active.members[1].membershipState, 'active');
    assert.throws(() => applyDescriptorOperation(active, {
        type: 'cancel-pending-member', repositoryId: 'repo-b', payloadPresent: false,
    }), (error) => error.statusCode === 409);

    const pending = applyDescriptorOperation(descriptor(), {
        type: 'add-member',
        member: { repositoryId: 'repo-c', githubRepositoryId: '1003', repo: 'owner/archive-c' },
    }).descriptor;
    const cancelled = applyDescriptorOperation(pending, {
        type: 'cancel-pending-member', repositoryId: 'repo-c', payloadPresent: false,
    });
    assert.equal(cancelled.descriptor.members.some((member) => member.repositoryId === 'repo-c'), false);
});

test('segment switch requires the expected active segment', () => {
    const operation = {
        type: 'switch-segment',
        laneId: 'lane-a',
        expectedActiveSegmentId: 'segment-a',
        segment: {
            segmentId: 'segment-b',
            repositoryId: 'repo-b',
            startedAt: '2026-07-25T01:00:00.000Z',
            reason: 'manual-switch',
        },
    };
    const switched = applyDescriptorOperation(descriptor(), operation);
    assert.equal(switched.descriptor.backupLanes['lane-a'].segments.length, 2);
    assert.throws(() => applyDescriptorOperation(switched.descriptor, operation), (error) => error.statusCode === 409);
});

test('descriptor CAS rereads and retries 409 without losing remote changes', async () => {
    const first = descriptor();
    const second = descriptor();
    second.revision = 4;
    second.members.push(repositoryMember({
        repositoryId: 'repo-remote',
        githubRepositoryId: '2000',
        repo: 'owner/remote-change',
    }));
    let reads = 0;
    let writes = 0;
    let written = null;
    const result = await updateDescriptorWithCas({
        read: async () => ({ descriptor: reads++ === 0 ? first : second, sha: reads === 1 ? 'sha-first' : 'sha-second' }),
        write: async ({ descriptor: next }) => {
            writes += 1;
            if (writes === 1) {
                const error = new Error('conflict');
                error.statusCode = 409;
                throw error;
            }
            written = next;
            return { sha: 'sha-written' };
        },
        operation: {
            type: 'add-member',
            member: { repositoryId: 'repo-new', githubRepositoryId: '3000', repo: 'owner/new' },
        },
        now: () => '2026-07-25T02:00:00.000Z',
    });
    assert.equal(writes, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.sha, 'sha-written');
    assert.equal(written.members.some((member) => member.repositoryId === 'repo-remote'), true);
    assert.equal(written.members.some((member) => member.repositoryId === 'repo-new'), true);
});

test('descriptor CAS does not retry non-conflict failures or exhausted conflicts', async () => {
    await assert.rejects(updateDescriptorWithCas({
        read: async () => ({ descriptor: descriptor(), sha: 'sha' }),
        write: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); },
        operation: { type: 'add-member', member: { repositoryId: 'repo-b', githubRepositoryId: '1002', repo: 'owner/b' } },
    }), (error) => error.statusCode === 403);

    let attempts = 0;
    await assert.rejects(updateDescriptorWithCas({
        read: async () => ({ descriptor: descriptor(), sha: `sha-${attempts}` }),
        write: async () => { attempts += 1; throw Object.assign(new Error('conflict'), { statusCode: 422 }); },
        operation: { type: 'add-member', member: { repositoryId: 'repo-b', githubRepositoryId: '1002', repo: 'owner/b' } },
        maxAttempts: 2,
    }), (error) => error.statusCode === 409);
    assert.equal(attempts, 2);
});

test('descriptor updates reject corrupt revisions before writing', () => {
    const corrupt = descriptor();
    corrupt.revision = 'not-a-number';
    assert.throws(() => applyDescriptorOperation(corrupt, {
        type: 'add-member',
        member: { repositoryId: 'repo-b', githubRepositoryId: '1002', repo: 'owner/b' },
    }), /revision must be a non-negative integer/);
});

test('member capabilities keep readable history separate from write eligibility', () => {
    const member = { membershipState: 'active' };
    assert.deepEqual(deriveMemberCapabilities({
        member,
        identityVerified: true,
        readPermission: true,
        writePermission: true,
        mirrorRevision: 3,
        catalogRevision: 4,
        lastValidatedAt: '2026-07-25T00:00:00.000Z',
    }), {
        readable: true,
        catalogSynced: false,
        writeEligible: false,
        lastValidatedAt: '2026-07-25T00:00:00.000Z',
    });
    assert.equal(deriveMemberCapabilities({
        member: { membershipState: 'pending' },
        identityVerified: true,
        readPermission: true,
        writePermission: true,
        mirrorRevision: 4,
        catalogRevision: 4,
    }).readable, false);
});

test('write eligibility rejects inactive, unconfigured, and tokenless members without trusting cached health', () => {
    const poolDescriptor = descriptor();
    const config = {
        configVersion: 2,
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-a',
        defaultToken: 'token-a',
        repositories: [{
            repositoryId: 'repo-a',
            githubRepositoryId: '1001',
            repo: 'owner/archive-a',
            membershipState: 'active',
        }],
    };
    assert.equal(resolveWriteEligibleMember(config, poolDescriptor, 'repo-a').context.token, 'token-a');

    config.repositories[0].lastKnownState = { writeEligible: false };
    assert.equal(resolveWriteEligibleMember(config, poolDescriptor, 'repo-a').context.repo, 'owner/archive-a');
    config.repositories[0].lastKnownState = { writeEligible: true };
    config.defaultToken = '';
    assert.throws(
        () => resolveWriteEligibleMember(config, poolDescriptor, 'repo-a'),
        (error) => error.statusCode === 403,
    );
    assert.throws(
        () => resolveWriteEligibleMember(config, poolDescriptor, 'repo-missing'),
        (error) => error.statusCode === 409,
    );
    poolDescriptor.members[0].membershipState = 'pending';
    assert.throws(
        () => resolveWriteEligibleMember(config, poolDescriptor, 'repo-a'),
        (error) => error.statusCode === 409,
    );
});

test('read routing requires an exact member in multi-member pools', () => {
    const poolDescriptor = descriptor();
    poolDescriptor.members.push(repositoryMember({
        repositoryId: 'repo-b',
        githubRepositoryId: '1002',
        repo: 'owner/archive-b',
    }));
    const config = {
        configVersion: 2,
        poolId: 'pool-a',
        catalogRepositoryId: 'repo-a',
        defaultToken: 'token',
        repositories: poolDescriptor.members,
    };
    assert.throws(() => resolveReadableMember(config, poolDescriptor), (error) => error.statusCode === 400);
    assert.equal(resolveReadableMember(config, poolDescriptor, 'repo-b').context.repo, 'owner/archive-b');
    assert.throws(
        () => resolveReadableMember(config, poolDescriptor, 'repo-unknown'),
        (error) => error.statusCode === 404,
    );
    config.repositories[1].lastKnownState = { readable: false };
    assert.equal(resolveReadableMember(config, poolDescriptor, 'repo-b').context.repo, 'owner/archive-b');
});

test('new lane reservations and pre-upload revalidation bind one member', () => {
    const created = createLaneReservation({
        backupRoot: 'default-user',
        deviceId: 'device-new',
        deviceName: 'New Device',
        repositoryId: 'repo-b',
        idFactory: (() => { let n = 0; return () => `new-${++n}`; })(),
        now: '2026-07-25T03:00:00.000Z',
    });
    const next = applyDescriptorOperation(descriptor(), {
        type: 'create-lane',
        laneId: created.laneId,
        lane: created.lane,
    }).descriptor;
    const resolved = resolveBackupReservation(next, {
        backupRoot: 'default-user',
        deviceId: 'device-new',
        deviceName: 'New Device',
    });
    assert.equal(resolved.reservation.repositoryId, 'repo-b');
    assert.doesNotThrow(() => assertReservationCurrent(next, resolved.reservation));
    const switched = applyDescriptorOperation(next, {
        type: 'switch-segment',
        laneId: created.laneId,
        expectedActiveSegmentId: created.segmentId,
        segment: {
            segmentId: 'segment-after',
            repositoryId: 'repo-a',
            startedAt: '2026-07-25T04:00:00.000Z',
            reason: 'manual-switch',
        },
    }).descriptor;
    assert.throws(() => assertReservationCurrent(switched, resolved.reservation), (error) => error.statusCode === 409);
});
