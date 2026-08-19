'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : crypto.randomBytes(16).toString('hex');
}

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parseGitHubRepositoryInput(value) {
    const input = trim(value);
    if (!input) throw new TypeError('GitHub repository is required.');
    const sshMatch = input.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    let owner = '';
    let repo = '';
    if (sshMatch) {
        [, owner, repo] = sshMatch;
    } else if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(input)) {
        const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
        if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) {
            throw new TypeError('Only github.com repository URLs are supported.');
        }
        const parts = url.pathname.split('/').filter(Boolean);
        [owner, repo] = parts;
    } else {
        const parts = input.replace(/^\/+|\/+$/g, '').split('/');
        if (parts.length === 2) [owner, repo] = parts;
    }
    repo = trim(repo).replace(/\.git$/i, '');
    owner = trim(owner);
    if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new TypeError('Invalid GitHub repository input.');
    }
    return { owner, repo, slug: `${owner}/${repo}` };
}

function normalizeDeviceKey(value) {
    return trim(value).toLowerCase();
}

function normalizeBackupRoot(value) {
    const raw = trim(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return !raw || raw === '.' || raw === 'data' ? '' : raw;
}

function deviceNameKeyHash(value) {
    return `sha256:${crypto.createHash('sha256').update(normalizeDeviceKey(value)).digest('hex')}`;
}

function idWithPrefix(prefix, idFactory) {
    return `${prefix}-${idFactory()}`;
}

function repositoryMember({ repositoryId, githubRepositoryId, repo, tokenOverride = '', addedAt, membershipState = 'active', lastKnownState = null }) {
    const normalizedState = lastKnownState && typeof lastKnownState === 'object' && !Array.isArray(lastKnownState)
        ? {
            readable: Boolean(lastKnownState.readable),
            catalogSynced: Boolean(lastKnownState.catalogSynced),
            writeEligible: Boolean(lastKnownState.writeEligible),
            lastValidatedAt: trim(lastKnownState.lastValidatedAt) || null,
        }
        : null;
    return {
        repositoryId: trim(repositoryId),
        githubRepositoryId: String(githubRepositoryId || ''),
        repo: trim(repo),
        membershipState,
        addedAt: addedAt || new Date().toISOString(),
        ...(tokenOverride ? { tokenOverride } : {}),
        ...(normalizedState ? { lastKnownState: normalizedState } : {}),
    };
}

function createEmptyDescriptor({ poolId, catalogRepositoryId, updatedAt = new Date().toISOString() }) {
    return {
        version: 1,
        revision: 0,
        poolId,
        catalogRepositoryId,
        members: [],
        backupLanes: {},
        updatedAt,
    };
}

function buildV2ConfigFromLegacy(input, { idFactory = createId, githubRepositoryId = '', now = new Date().toISOString() } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Legacy config must be an object.');
    }
    if (Number(input.configVersion) === 2) {
        const members = Array.isArray(input.repositories) ? input.repositories : [];
        const hasConfiguredMember = members.some((member) => trim(member?.repo));
        if (hasConfiguredMember || !trim(input.repo) || !trim(input.token)) {
            return normalizeV2Config(input);
        }

        // A deleted config is recreated as an empty v2 pool before the user adds
        // the first repository. Rebuild that placeholder as a new pool instead
        // of preserving its empty catalog member.
        const {
            configVersion,
            poolId,
            catalogRepositoryId,
            repositories,
            descriptorCache,
            ...legacyInput
        } = input;
        return buildV2ConfigFromLegacy(legacyInput, { idFactory, githubRepositoryId, now });
    }

    const repo = trim(input.repo);
    const token = trim(input.token);
    const repositoryId = idWithPrefix('repo', idFactory);
    const poolId = idWithPrefix('pool', idFactory);
    const member = repositoryMember({
        repositoryId,
        githubRepositoryId,
        repo,
        tokenOverride: '',
        addedAt: now,
    });
    return {
        configVersion: 2,
        poolId,
        catalogRepositoryId: repositoryId,
        defaultToken: token,
        repositories: [member],
        descriptorCache: null,
        backupRoot: normalizeBackupRoot(input.backupRoot),
        deviceId: trim(input.deviceId) || idFactory(),
        deviceName: trim(input.deviceName),
        lastBackupAt: input.lastBackupAt || null,
        autoBackupEnabled: Boolean(input.autoBackupEnabled),
        autoBackupIntervalMinutes: input.autoBackupIntervalMinutes,
        autoBackupKeepCount: input.autoBackupKeepCount,
        manualBackupKeepCount: input.manualBackupKeepCount,
    };
}

function normalizeV2Config(input) {
    if (!trim(input.poolId) || !trim(input.catalogRepositoryId) || !Array.isArray(input.repositories)) {
        throw new TypeError('Invalid config v2 identity or repositories.');
    }
    const repositories = input.repositories.map((member) => repositoryMember(member));
    if (!repositories.some((member) => member.repositoryId === input.catalogRepositoryId)) {
        throw new TypeError('Catalog repository is not a configured member.');
    }
    return {
        ...input,
        configVersion: 2,
        poolId: trim(input.poolId),
        catalogRepositoryId: trim(input.catalogRepositoryId),
        defaultToken: trim(input.defaultToken),
        repositories,
        descriptorCache: input.descriptorCache || null,
    };
}

function toRuntimeConfig(v2) {
    const normalized = normalizeV2Config(v2);
    const catalog = normalized.repositories.find((member) => member.repositoryId === normalized.catalogRepositoryId);
    if (!catalog) throw new TypeError('Catalog repository is not a configured member.');
    const runtime = {
        configVersion: 2,
        poolId: normalized.poolId,
        catalogRepositoryId: normalized.catalogRepositoryId,
        repositories: normalized.repositories,
        descriptorCache: normalized.descriptorCache,
        repo: catalog.repo,
        token: catalog.tokenOverride || normalized.defaultToken,
        backupRoot: normalized.backupRoot,
        deviceId: normalized.deviceId,
        deviceName: normalized.deviceName,
        lastBackupAt: normalized.lastBackupAt,
        autoBackupEnabled: normalized.autoBackupEnabled,
        autoBackupIntervalMinutes: normalized.autoBackupIntervalMinutes,
        autoBackupKeepCount: normalized.autoBackupKeepCount,
        manualBackupKeepCount: normalized.manualBackupKeepCount,
    };
    Object.defineProperty(runtime, '__poolConfig', {
        value: normalized,
        enumerable: false,
        writable: true,
    });
    return runtime;
}

function serializeRuntimeConfig(runtime) {
    if (!runtime?.__poolConfig) return runtime;
    const pool = JSON.parse(JSON.stringify(runtime.__poolConfig));
    pool.backupRoot = runtime.backupRoot;
    pool.deviceId = runtime.deviceId;
    pool.deviceName = runtime.deviceName;
    pool.lastBackupAt = runtime.lastBackupAt;
    pool.autoBackupEnabled = runtime.autoBackupEnabled;
    pool.autoBackupIntervalMinutes = runtime.autoBackupIntervalMinutes;
    pool.autoBackupKeepCount = runtime.autoBackupKeepCount;
    pool.manualBackupKeepCount = runtime.manualBackupKeepCount;
    pool.defaultToken = trim(runtime.token);
    const catalog = pool.repositories.find((member) => member.repositoryId === pool.catalogRepositoryId);
    if (catalog) catalog.repo = trim(runtime.repo);
    return normalizeV2Config(pool);
}

function updateRuntimeMemberCredential(runtime, repositoryId, token) {
    const pool = runtime?.__poolConfig;
    const normalizedToken = trim(token);
    if (!pool || !normalizedToken) throw new TypeError('A v2 runtime config and token are required.');
    const member = pool.repositories.find((candidate) => candidate.repositoryId === trim(repositoryId));
    if (!member) throw new Error(`Unknown repository member: ${repositoryId}`);
    if (member.repositoryId === pool.catalogRepositoryId) {
        pool.defaultToken = normalizedToken;
        runtime.token = normalizedToken;
        delete member.tokenOverride;
    } else {
        member.tokenOverride = normalizedToken;
    }
    delete member.lastKnownState;
    return member;
}

function resolveMemberContext(config, repositoryId = null) {
    const pool = config?.__poolConfig || config;
    if (!pool || Number(pool.configVersion) !== 2) {
        return {
            repositoryId: repositoryId || 'legacy-catalog',
            githubRepositoryId: '',
            repo: trim(config?.repo),
            token: trim(config?.token),
            membershipState: 'active',
        };
    }
    const targetId = repositoryId || pool.catalogRepositoryId;
    const member = pool.repositories.find((candidate) => candidate.repositoryId === targetId);
    if (!member) throw new Error(`Unknown repository member: ${targetId}`);
    return {
        repositoryId: member.repositoryId,
        githubRepositoryId: String(member.githubRepositoryId || ''),
        repo: member.repo,
        token: member.tokenOverride || pool.defaultToken,
        membershipState: member.membershipState || 'active',
    };
}

function resolveWriteEligibleMember(config, descriptor, repositoryId) {
    const member = descriptor?.members?.find((candidate) => candidate.repositoryId === repositoryId);
    if (!member || member.membershipState !== 'active') {
        throw Object.assign(new Error('Repository is not an active pool member.'), { statusCode: 409 });
    }
    const context = resolveMemberContext(config, repositoryId);
    if (!context.token) {
        throw Object.assign(new Error('Repository has no usable token.'), { statusCode: 403 });
    }
    return { member, context };
}

function resolveReadableMember(config, descriptor, repositoryId = '') {
    const members = (descriptor?.members || []).filter((member) => member.membershipState === 'active');
    const requestedId = trim(repositoryId);
    if (!requestedId && members.length !== 1) {
        throw Object.assign(new Error('repositoryId is required for a multi-member pool.'), { statusCode: 400 });
    }
    const targetId = requestedId || members[0]?.repositoryId;
    const member = members.find((candidate) => candidate.repositoryId === targetId);
    if (!member) {
        throw Object.assign(new Error('Repository is not an active pool member.'), { statusCode: 404 });
    }
    let context;
    try {
        context = resolveMemberContext(config, targetId);
    } catch (error) {
        throw Object.assign(new Error('Repository member is not configured locally.'), { statusCode: 409 });
    }
    if (!context.token) {
        throw Object.assign(new Error('Repository has no usable token.'), { statusCode: 403 });
    }
    return { member, context };
}

function bindRuntimeConfigToMember(config, repositoryId) {
    const context = resolveMemberContext(config, repositoryId);
    const bound = { ...config, repo: context.repo, token: context.token };
    Object.defineProperty(bound, '__poolConfig', {
        value: config.__poolConfig,
        enumerable: false,
        writable: true,
    });
    Object.defineProperty(bound, '__memberContext', {
        value: context,
        enumerable: false,
    });
    return bound;
}

function verifyGitHubRepositoryIdentity(context, repositoryInfo, { allowBootstrap = true } = {}) {
    const actualId = String(repositoryInfo?.id || '');
    if (!actualId) throw new Error('GitHub repository response has no immutable id.');
    if (context.githubRepositoryId && context.githubRepositoryId !== actualId) {
        throw new Error(`GitHub repository identity mismatch for ${context.repositoryId}`);
    }
    if (!context.githubRepositoryId && !allowBootstrap) {
        throw new Error(`GitHub repository identity is not established for ${context.repositoryId}`);
    }
    return { ...context, githubRepositoryId: actualId };
}

function buildMemberMarker({ poolId, catalogRepositoryId, context, createdAt = new Date().toISOString() }) {
    if (!poolId || !catalogRepositoryId || !context?.repositoryId || !context.githubRepositoryId) {
        throw new TypeError('Complete pool and repository identity are required for a marker.');
    }
    return {
        version: 1,
        poolId,
        repositoryId: context.repositoryId,
        githubRepositoryId: String(context.githubRepositoryId),
        catalogRepositoryId,
        createdAt,
    };
}

function validateMemberMarker(marker, { poolId, repositoryId, githubRepositoryId, catalogRepositoryId }) {
    if (!marker || marker.version !== 1) throw new Error('Unsupported Archive Reserve pool marker.');
    if (marker.poolId !== poolId) throw new Error('Archive Reserve pool ID mismatch.');
    if (marker.repositoryId !== repositoryId) throw new Error('Archive Reserve repository ID mismatch.');
    if (String(marker.githubRepositoryId) !== String(githubRepositoryId)) throw new Error('Archive Reserve GitHub repository ID mismatch.');
    if (marker.catalogRepositoryId !== catalogRepositoryId) throw new Error('Archive Reserve catalog ID mismatch.');
    return true;
}

function adoptRemoteDescriptor(config, descriptor, githubRepositoryId) {
    const pool = config?.__poolConfig;
    if (!pool) throw new TypeError('A v2 runtime config is required to adopt a remote pool.');
    const remoteMember = descriptor?.members?.find((member) => (
        String(member.githubRepositoryId) === String(githubRepositoryId)
    ));
    if (!remoteMember) throw new Error('Remote pool has no member for this GitHub repository.');
    const localMember = pool.repositories.find((member) => (
        member.repositoryId === pool.catalogRepositoryId
        || String(member.githubRepositoryId) === String(githubRepositoryId)
    ));
    if (!localMember) throw new Error('Local config has no member to adopt into the remote pool.');
    const localCredentials = new Map(pool.repositories.map((member) => [
        String(member.githubRepositoryId),
        member.tokenOverride || '',
    ]));
    pool.repositories = pool.repositories.map((member) => {
        const remote = descriptor.members.find((candidate) => (
            String(candidate.githubRepositoryId) === String(member.githubRepositoryId)
        ));
        return remote
            ? repositoryMember({
                ...remote,
                tokenOverride: localCredentials.get(String(member.githubRepositoryId)) || '',
            })
            : member;
    });
    pool.poolId = descriptor.poolId;
    const remoteCatalog = descriptor.members.find((member) => member.repositoryId === descriptor.catalogRepositoryId);
    const localCatalog = pool.repositories.find((member) => member.repositoryId === pool.catalogRepositoryId);
    const adoptedCatalog = pool.repositories.find((member) => (
        remoteCatalog && String(member.githubRepositoryId) === String(remoteCatalog.githubRepositoryId)
    ));
    const localCatalogIsRemote = localCatalog && descriptor.members.some((member) => (
        String(member.githubRepositoryId) === String(localCatalog.githubRepositoryId)
    ));
    pool.catalogRepositoryId = adoptedCatalog?.repositoryId
        || (localCatalogIsRemote ? localCatalog.repositoryId : remoteMember.repositoryId);
    pool.descriptorCache = {
        revision: descriptor.revision,
        sha: null,
        fetchedAt: new Date().toISOString(),
        stale: false,
        descriptor,
    };
    config.poolId = pool.poolId;
    config.catalogRepositoryId = pool.catalogRepositoryId;
    config.repositories = pool.repositories;
    const catalogMember = pool.repositories.find((member) => member.repositoryId === pool.catalogRepositoryId);
    if (!catalogMember) throw new Error('Remote pool has no catalog member.');
    config.repo = catalogMember.repo;
    config.token = catalogMember.tokenOverride || pool.defaultToken;
    return config;
}

function deriveMemberCapabilities({
    member,
    identityVerified = false,
    readPermission = false,
    writePermission = false,
    mirrorRevision = null,
    catalogRevision = null,
    lastValidatedAt = null,
}) {
    const active = member?.membershipState === 'active';
    const readable = active && identityVerified && readPermission;
    const catalogSynced = readable
        && Number.isInteger(mirrorRevision)
        && mirrorRevision === catalogRevision;
    return {
        readable,
        catalogSynced,
        writeEligible: catalogSynced && writePermission,
        lastValidatedAt,
    };
}

function descriptorConflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function bumpDescriptor(descriptor, now = new Date().toISOString()) {
    const revision = Number(descriptor.revision);
    if (!Number.isInteger(revision) || revision < 0) throw new TypeError('Descriptor revision must be a non-negative integer.');
    descriptor.revision = revision + 1;
    descriptor.updatedAt = now;
    assertTokenFreeDescriptor(descriptor);
    return descriptor;
}

function applyDescriptorOperation(descriptor, operation, { now = new Date().toISOString() } = {}) {
    const next = clone(descriptor);
    const type = operation?.type;
    if (type === 'add-member') {
        const member = repositoryMember(operation.member);
        const existing = next.members.find((candidate) => candidate.repositoryId === member.repositoryId);
        if (existing) {
            if (existing.githubRepositoryId !== member.githubRepositoryId || existing.repo !== member.repo) {
                throw descriptorConflict(`Repository member identity conflict: ${member.repositoryId}`);
            }
            return { descriptor: next, changed: false };
        }
        if (next.members.some((candidate) => (
            candidate.githubRepositoryId === member.githubRepositoryId
            || candidate.repo === member.repo
        ))) {
            throw descriptorConflict('Repository member identity is already in this pool.');
        }
        next.members.push({ ...member, membershipState: 'pending' });
        return { descriptor: bumpDescriptor(next, now), changed: true };
    }
    if (type === 'activate-member') {
        const member = next.members.find((candidate) => candidate.repositoryId === operation.repositoryId);
        if (!member) throw descriptorConflict(`Unknown pending member: ${operation.repositoryId}`);
        if (member.membershipState === 'active') return { descriptor: next, changed: false };
        if (member.membershipState !== 'pending') throw descriptorConflict('Only pending members can be activated.');
        member.membershipState = 'active';
        return { descriptor: bumpDescriptor(next, now), changed: true };
    }
    if (type === 'cancel-pending-member') {
        const member = next.members.find((candidate) => candidate.repositoryId === operation.repositoryId);
        if (!member) return { descriptor: next, changed: false };
        if (member.membershipState !== 'pending' || operation.payloadPresent) {
            throw descriptorConflict('Only empty pending members can be cancelled.');
        }
        next.members = next.members.filter((candidate) => candidate.repositoryId !== operation.repositoryId);
        return { descriptor: bumpDescriptor(next, now), changed: true };
    }
    if (type === 'create-lane') {
        if (next.backupLanes[operation.laneId]) return { descriptor: next, changed: false };
        const identity = operation.lane?.identity;
        if (!identity) throw new TypeError('Lane identity is required.');
        const duplicate = Object.values(next.backupLanes).some((lane) => (
            lane.identity.backupRoot === identity.backupRoot
            && lane.identity.deviceId === identity.deviceId
        ));
        if (duplicate) throw descriptorConflict('A lane already owns this backup root and device ID.');
        next.backupLanes[operation.laneId] = clone(operation.lane);
        return { descriptor: bumpDescriptor(next, now), changed: true };
    }
    if (type === 'add-device-alias') {
        const updated = addDeviceIdAlias(next, operation.laneId, operation.deviceId);
        if (JSON.stringify(updated) === JSON.stringify(next)) return { descriptor: next, changed: false };
        return { descriptor: bumpDescriptor(updated, now), changed: true };
    }
    if (type === 'switch-segment') {
        const lane = next.backupLanes[operation.laneId];
        if (!lane) throw descriptorConflict(`Unknown lane: ${operation.laneId}`);
        const active = lane.segments[lane.segments.length - 1];
        if (!active || active.segmentId !== operation.expectedActiveSegmentId) {
            throw descriptorConflict('Active segment changed; retry the switch.');
        }
        if (!operation.segment?.segmentId || !operation.segment.repositoryId || !operation.segment.startedAt) {
            throw new TypeError('A new segment needs an ID, member, and start time.');
        }
        lane.segments.push(clone(operation.segment));
        return { descriptor: bumpDescriptor(next, now), changed: true };
    }
    throw new TypeError(`Unknown descriptor operation: ${type}`);
}

async function updateDescriptorWithCas({ read, write, operation, maxAttempts = 3, now = () => new Date().toISOString() }) {
    if (typeof read !== 'function' || typeof write !== 'function') {
        throw new TypeError('Descriptor CAS requires read and write functions.');
    }
    let lastConflict = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const snapshot = await read();
        assertTokenFreeDescriptor(snapshot.descriptor);
        const applied = applyDescriptorOperation(snapshot.descriptor, operation, { now: now() });
        if (!applied.changed) return { ...snapshot, descriptor: applied.descriptor, attempts: attempt };
        try {
            const written = await write({ descriptor: applied.descriptor, sha: snapshot.sha });
            return { descriptor: applied.descriptor, sha: written?.sha || snapshot.sha, attempts: attempt };
        } catch (error) {
            if (error?.statusCode !== 409 && error?.statusCode !== 422) throw error;
            lastConflict = error;
        }
    }
    const error = descriptorConflict('Descriptor update conflicted repeatedly; retry later.');
    error.cause = lastConflict;
    throw error;
}

function createLaneReservation({ backupRoot, deviceId, deviceName, repositoryId, idFactory = createId, now = new Date().toISOString() }) {
    const laneId = idWithPrefix('lane', idFactory);
    const segmentId = idWithPrefix('segment', idFactory);
    return {
        laneId,
        segmentId,
        repositoryId,
        lane: {
            identity: {
                backupRoot: normalizeBackupRoot(backupRoot),
                deviceId: trim(deviceId),
                deviceIdAliases: [],
                deviceNameKeyHash: deviceNameKeyHash(deviceName),
            },
            segments: [{ segmentId, repositoryId, startedAt: now, reason: 'initial' }],
        },
    };
}

function resolveBackupReservation(descriptor, identity) {
    const match = findLane(descriptor, identity);
    if (!match.lane) return { ...match, reservation: null };
    const segment = match.lane.segments[match.lane.segments.length - 1];
    if (!segment) throw new Error(`Lane has no segment: ${match.laneId}`);
    return {
        ...match,
        reservation: {
            laneId: match.laneId,
            segmentId: segment.segmentId,
            repositoryId: segment.repositoryId,
            descriptorRevision: descriptor.revision,
        },
    };
}

function assertReservationCurrent(descriptor, reservation) {
    const lane = descriptor?.backupLanes?.[reservation?.laneId];
    const active = lane?.segments?.[lane.segments.length - 1];
    if (!active
        || active.segmentId !== reservation.segmentId
        || active.repositoryId !== reservation.repositoryId) {
        throw descriptorConflict('Backup segment changed before remote upload; retry the backup.');
    }
    return true;
}

function laneFromGroup(group, { idFactory = createId, repositoryId = '' } = {}) {
    const first = group[0];
    const deviceName = trim(first.device?.name);
    return {
        laneId: idWithPrefix('lane', idFactory),
        identity: {
            backupRoot: normalizeBackupRoot(first.backupRoot?.root),
            deviceId: trim(first.device?.id),
            deviceIdAliases: [],
            deviceNameKeyHash: deviceNameKeyHash(deviceName),
        },
        segments: [{
            segmentId: idWithPrefix('segment', idFactory),
            repositoryId,
            startedAt: null,
            reason: 'legacy-initial',
        }],
    };
}

function buildLegacyLaneInventory(backups, { idFactory = createId, repositoryId = '' } = {}) {
    const exactGroups = new Map();
    const missingIdGroups = new Map();
    const unresolved = [];
    for (const backup of Array.isArray(backups) ? backups : []) {
        const timestamp = backup.createdAt || backup.publishedAt;
        if (timestamp && !Number.isFinite(Date.parse(timestamp))) {
            unresolved.push({ backup, reason: 'invalid-created-at' });
            continue;
        }
        const root = normalizeBackupRoot(backup.backupRoot?.root);
        const deviceId = trim(backup.device?.id);
        const name = normalizeDeviceKey(backup.device?.name);
        if (deviceId) {
            const key = `${root}\u0000${deviceId}`;
            if (!exactGroups.has(key)) exactGroups.set(key, []);
            exactGroups.get(key).push(backup);
        } else if (name) {
            const key = `${root}\u0000${name}`;
            if (!missingIdGroups.has(key)) missingIdGroups.set(key, []);
            missingIdGroups.get(key).push(backup);
        } else {
            unresolved.push({ backup, reason: 'missing-device-identity' });
        }
    }

    const lanes = {};
    for (const group of exactGroups.values()) {
        const lane = laneFromGroup(group, { idFactory, repositoryId });
        lanes[lane.laneId] = lane;
    }
    for (const group of missingIdGroups.values()) {
        if (group.length !== 1) {
            unresolved.push(...group.map((backup) => ({ backup, reason: 'ambiguous-device-name' })));
            continue;
        }
        const lane = laneFromGroup(group, { idFactory, repositoryId });
        lanes[lane.laneId] = lane;
    }
    return { lanes, unresolved };
}

function findLane(descriptor, { backupRoot, deviceId, deviceName } = {}) {
    const root = normalizeBackupRoot(backupRoot);
    const requestedDeviceId = trim(deviceId);
    const exact = requestedDeviceId ? Object.entries(descriptor?.backupLanes || {}).filter(([, lane]) => (
        lane.identity.backupRoot === root
        && (lane.identity.deviceId === requestedDeviceId
            || lane.identity.deviceIdAliases?.includes(requestedDeviceId))
    )) : [];
    if (exact.length === 1) return { laneId: exact[0][0], lane: exact[0][1], match: 'device-id' };
    if (exact.length > 1) return { laneId: null, lane: null, match: 'ambiguous' };

    const nameHash = deviceNameKeyHash(deviceName);
    const byName = Object.entries(descriptor?.backupLanes || {}).filter(([, lane]) => (
        lane.identity.backupRoot === root && lane.identity.deviceNameKeyHash === nameHash
    ));
    if (byName.length === 1) return { laneId: byName[0][0], lane: byName[0][1], match: 'device-name' };
    return { laneId: null, lane: null, match: byName.length ? 'ambiguous' : 'none' };
}

function addDeviceIdAlias(descriptor, laneId, alias) {
    const normalizedAlias = trim(alias);
    if (!normalizedAlias) throw new TypeError('Device ID alias is required.');
    const copy = JSON.parse(JSON.stringify(descriptor));
    const lane = copy.backupLanes?.[laneId];
    if (!lane) throw new Error(`Unknown lane: ${laneId}`);
    const currentOwns = lane.identity.deviceId === normalizedAlias
        || lane.identity.deviceIdAliases?.includes(normalizedAlias);
    if (currentOwns) return copy;
    const otherOwns = Object.entries(copy.backupLanes).some(([candidateId, candidate]) => (
        candidateId !== laneId
        && (candidate.identity.deviceId === normalizedAlias
            || candidate.identity.deviceIdAliases?.includes(normalizedAlias))
    ));
    if (otherOwns) throw new Error(`Device ID alias already belongs to another lane: ${normalizedAlias}`);
    lane.identity.deviceIdAliases = Array.from(new Set([
        ...(lane.identity.deviceIdAliases || []),
        normalizedAlias,
    ]));
    return copy;
}

function assertTokenFreeDescriptor(descriptor) {
    const visit = (value, pathParts = []) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (/token/i.test(key)) {
                throw new Error(`Descriptor contains forbidden token field at ${pathParts.concat(key).join('.')}`);
            }
            visit(child, pathParts.concat(key));
        }
    };
    visit(descriptor);
    return descriptor;
}

async function writeJsonAtomically(filePath, value, { backup = true } = {}) {
    const directory = path.dirname(filePath);
    await fsp.mkdir(directory, { recursive: true });
    if (backup) {
        try {
            await fsp.copyFile(filePath, `${filePath}.bak`);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    const tempPath = `${filePath}.${process.pid}.${createId()}.tmp`;
    let committed = false;
    try {
        const handle = await fsp.open(tempPath, 'w', 0o600);
        try {
            await handle.writeFile(JSON.stringify(value, null, 2));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fsp.rename(tempPath, filePath);
        committed = true;
    } finally {
        if (!committed) await fsp.rm(tempPath, { force: true });
    }
}

module.exports = {
    buildLegacyLaneInventory,
    buildV2ConfigFromLegacy,
    bindRuntimeConfigToMember,
    createEmptyDescriptor,
    createLaneReservation,
    deviceNameKeyHash,
    deriveMemberCapabilities,
    addDeviceIdAlias,
    adoptRemoteDescriptor,
    assertTokenFreeDescriptor,
    findLane,
    normalizeBackupRoot,
    normalizeDeviceKey,
    parseGitHubRepositoryInput,
    normalizeV2Config,
    repositoryMember,
    resolveBackupReservation,
    resolveMemberContext,
    resolveReadableMember,
    resolveWriteEligibleMember,
    assertReservationCurrent,
    serializeRuntimeConfig,
    toRuntimeConfig,
    updateRuntimeMemberCredential,
    verifyGitHubRepositoryIdentity,
    buildMemberMarker,
    applyDescriptorOperation,
    validateMemberMarker,
    updateDescriptorWithCas,
    writeJsonAtomically,
};
