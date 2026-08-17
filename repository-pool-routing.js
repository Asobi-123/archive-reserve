'use strict';

const RETRYABLE_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isRetryableGitHubStatus(status) {
    return RETRYABLE_GITHUB_STATUSES.has(Number(status));
}

function parseGraphqlReleasePage(payload) {
    if (Array.isArray(payload?.errors) && payload.errors.length) {
        throw new Error(payload.errors.map((error) => error.message).join('; '));
    }
    const connection = payload?.data?.repository?.releases;
    if (!connection || !Array.isArray(connection.nodes)) {
        throw new Error('GitHub GraphQL did not return a release connection.');
    }
    const releaseIds = connection.nodes.map((release) => Number(release?.databaseId));
    if (releaseIds.some((releaseId) => !Number.isSafeInteger(releaseId) || releaseId <= 0)) {
        throw new Error('GitHub GraphQL returned an invalid release ID.');
    }
    const hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    const endCursor = connection.pageInfo?.endCursor || null;
    if (hasNextPage && !endCursor) {
        throw new Error('GitHub GraphQL pagination cursor is missing.');
    }
    return {
        releaseIds,
        hasNextPage,
        endCursor,
    };
}

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

module.exports = {
    aggregateMemberBackupResults,
    assertBackupRepository,
    isRetryableGitHubStatus,
    parseGraphqlReleasePage,
};
