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

function repositoryMember({ repositoryId, githubRepositoryId, repo, tokenOverride = '', addedAt, membershipState = 'active' }) {
    return {
        repositoryId: trim(repositoryId),
        githubRepositoryId: String(githubRepositoryId || ''),
        repo: trim(repo),
        membershipState,
        addedAt: addedAt || new Date().toISOString(),
        ...(tokenOverride ? { tokenOverride } : {}),
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
        return normalizeV2Config(input);
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
    createEmptyDescriptor,
    deviceNameKeyHash,
    addDeviceIdAlias,
    assertTokenFreeDescriptor,
    findLane,
    normalizeBackupRoot,
    normalizeDeviceKey,
    normalizeV2Config,
    repositoryMember,
    serializeRuntimeConfig,
    toRuntimeConfig,
    writeJsonAtomically,
};
