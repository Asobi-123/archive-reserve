'use strict';

function aggregateMemberBackupResults(results, { descriptorStale = false, descriptorError = null, checkedAt = new Date().toISOString() } = {}) {
    const members = results.map(({ backups: ignored, ...member }) => member);
    const backups = results
        .flatMap((member) => (member.backups || []).map((backup) => ({
            ...backup,
            repositoryId: member.repositoryId,
            source: { repositoryId: member.repositoryId, repo: member.repo },
            freshness: { stale: false, checkedAt: member.lastValidatedAt },
        })))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    return {
        backups,
        members,
        partial: members.some((member) => !member.readable),
        freshness: {
            stale: Boolean(descriptorStale),
            checkedAt,
            error: descriptorError?.message || null,
        },
    };
}

function assertBackupRepository(meta, repositoryId) {
    if (meta?.repositoryId && meta.repositoryId !== repositoryId) {
        throw Object.assign(new Error('Backup metadata repository does not match the selected source.'), {
            statusCode: 409,
        });
    }
    return true;
}

module.exports = { aggregateMemberBackupResults, assertBackupRepository };
