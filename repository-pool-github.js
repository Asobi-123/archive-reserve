'use strict';

const {
    assertTokenFreeDescriptor,
    buildLegacyLaneInventory,
    buildMemberMarker,
    createEmptyDescriptor,
    repositoryMember,
    updateDescriptorWithCas,
    validateMemberMarker,
} = require('./repository-pool');

const DESCRIPTOR_PATH = '.archive-reserve.pool.json';
const MARKER_PATH = '.archive-reserve.pool.marker.json';

function repoApiPath(context) {
    const parts = String(context?.repo || '').split('/').filter(Boolean);
    if (parts.length !== 2) throw new TypeError(`Invalid GitHub repository slug: ${context?.repo || ''}`);
    return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function decodeJsonContent(response, filePath) {
    if (!response || response.type === 'dir' || typeof response.content !== 'string') {
        throw new Error(`GitHub Contents response is not a file: ${filePath}`);
    }
    try {
        return JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    } catch (error) {
        throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
}

function createRepositoryPoolStore({ request }) {
    if (typeof request !== 'function') throw new TypeError('Repository pool store requires a request function.');

    async function readJson(context, filePath) {
        try {
            const response = await request(context, `${repoApiPath(context)}/contents/${encodeURIComponent(filePath)}`);
            return { exists: true, value: decodeJsonContent(response, filePath), sha: response.sha };
        } catch (error) {
            if (error?.statusCode === 404) return { exists: false, value: null, sha: null };
            throw error;
        }
    }

    async function writeJson(context, filePath, value, { sha = null, message = `Update ${filePath}` } = {}) {
        const payload = {
            message,
            content: Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64'),
            ...(sha ? { sha } : {}),
        };
        const response = await request(context, `${repoApiPath(context)}/contents/${encodeURIComponent(filePath)}`, {
            method: 'PUT',
            json: payload,
        });
        return { sha: response?.content?.sha || response?.sha || null, response };
    }

    async function readDescriptor(context) {
        const result = await readJson(context, DESCRIPTOR_PATH);
        if (result.exists) assertTokenFreeDescriptor(result.value);
        return result;
    }

    async function writeDescriptor(context, descriptor, options = {}) {
        assertTokenFreeDescriptor(descriptor);
        return await writeJson(context, DESCRIPTOR_PATH, descriptor, {
            message: 'Update Archive Reserve pool descriptor',
            ...options,
        });
    }

    async function updateDescriptor(context, operation, { maxAttempts = 3, now } = {}) {
        return await updateDescriptorWithCas({
            read: async () => {
                const current = await readDescriptor(context);
                if (!current.exists) throw new Error('Archive Reserve pool descriptor does not exist.');
                return { descriptor: current.value, sha: current.sha };
            },
            write: async ({ descriptor, sha }) => await writeDescriptor(context, descriptor, { sha }),
            operation,
            maxAttempts,
            ...(now ? { now } : {}),
        });
    }

    async function ensureMarker(context, marker, current = null) {
        const existing = current || await readJson(context, MARKER_PATH);
        if (existing.exists) {
            validateMemberMarker(existing.value, marker);
            return existing;
        }
        try {
            const written = await writeJson(context, MARKER_PATH, marker, { message: 'Create Archive Reserve pool marker' });
            return { exists: true, value: marker, sha: written.sha };
        } catch (error) {
            if (error?.statusCode !== 409 && error?.statusCode !== 422) throw error;
            const raced = await readJson(context, MARKER_PATH);
            if (!raced.exists) throw error;
            validateMemberMarker(raced.value, marker);
            return raced;
        }
    }

    async function useExistingCatalog(context, markerResult, descriptorResult, localPoolId, now) {
        const descriptor = descriptorResult.value;
        const remoteMember = descriptor.members.find((member) => (
            String(member.githubRepositoryId) === String(context.githubRepositoryId)
        ));
        if (!remoteMember) throw new Error('Catalog descriptor does not contain this GitHub repository.');
        const marker = buildMemberMarker({
            poolId: descriptor.poolId,
            catalogRepositoryId: descriptor.catalogRepositoryId,
            context: { ...context, repositoryId: remoteMember.repositoryId },
            createdAt: markerResult.value?.createdAt || now,
        });
        await ensureMarker(context, marker, markerResult);
        return { descriptor, sha: descriptorResult.sha, adopted: descriptor.poolId !== localPoolId };
    }

    async function ensureCatalog({ context, poolId, catalogRepositoryId, backups = [], now = new Date().toISOString() }) {
        const [markerResult, descriptorResult] = await Promise.all([
            readJson(context, MARKER_PATH),
            readDescriptor(context),
        ]);
        if (descriptorResult.exists) {
            return await useExistingCatalog(context, markerResult, descriptorResult, poolId, now);
        }

        const marker = buildMemberMarker({ poolId, catalogRepositoryId, context, createdAt: now });
        if (markerResult.exists) validateMemberMarker(markerResult.value, marker);
        const inventory = buildLegacyLaneInventory(backups, { repositoryId: context.repositoryId });
        const descriptor = createEmptyDescriptor({ poolId, catalogRepositoryId, updatedAt: now });
        descriptor.members = [repositoryMember({
            repositoryId: context.repositoryId,
            githubRepositoryId: context.githubRepositoryId,
            repo: context.repo,
            membershipState: 'active',
            addedAt: now,
        })];
        descriptor.backupLanes = inventory.lanes;

        await ensureMarker(context, marker, markerResult);
        let written;
        try {
            written = await writeDescriptor(context, descriptor);
        } catch (error) {
            if (error?.statusCode !== 409 && error?.statusCode !== 422) throw error;
            const racedDescriptor = await readDescriptor(context);
            const racedMarker = await readJson(context, MARKER_PATH);
            if (!racedDescriptor.exists) throw error;
            return await useExistingCatalog(context, racedMarker, racedDescriptor, poolId, now);
        }
        return { descriptor, sha: written.sha, adopted: false, unresolved: inventory.unresolved };
    }

    async function syncDescriptorMirror(context, descriptor) {
        const current = await readDescriptor(context);
        if (current.exists
            && current.value.revision === descriptor.revision
            && JSON.stringify(current.value) === JSON.stringify(descriptor)) {
            return { repositoryId: context.repositoryId, synced: true, sha: current.sha, changed: false };
        }
        const written = await writeDescriptor(context, descriptor, { sha: current.sha });
        return { repositoryId: context.repositoryId, synced: true, sha: written.sha, changed: true };
    }

    async function syncDescriptorMirrors(contexts, descriptor) {
        const settled = await Promise.allSettled(contexts.map((context) => syncDescriptorMirror(context, descriptor)));
        return settled.map((result, index) => result.status === 'fulfilled'
            ? result.value
            : { repositoryId: contexts[index].repositoryId, synced: false, error: result.reason });
    }

    return {
        ensureCatalog,
        readDescriptor,
        readJson,
        syncDescriptorMirror,
        syncDescriptorMirrors,
        updateDescriptor,
        writeDescriptor,
        writeJson,
    };
}

module.exports = {
    DESCRIPTOR_PATH,
    MARKER_PATH,
    createRepositoryPoolStore,
    decodeJsonContent,
};
