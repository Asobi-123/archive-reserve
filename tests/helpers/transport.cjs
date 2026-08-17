'use strict';

const REDACTED = '[redacted]';

function createHttpError(statusCode, message = `GitHub request failed with ${statusCode}`) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function createTimeoutError(message = 'GitHub request timed out') {
    const error = new Error(message);
    error.code = 'ETIMEDOUT';
    return error;
}

function cloneJson(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function redactHeaders(headers = {}) {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
        name,
        /authorization|token/i.test(name) ? REDACTED : value,
    ]));
}

function matchesEndpoint(matcher, endpoint) {
    if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
        return matcher.test(endpoint);
    }
    if (typeof matcher === 'function') {
        return Boolean(matcher(endpoint));
    }
    return matcher === endpoint;
}

function createGitHubTransportFixture({ members = [] } = {}) {
    const memberMap = new Map(members.map((member) => [member.repositoryId, { ...member }]));
    const routes = [];
    const calls = [];

    function getMember(repositoryId) {
        const member = memberMap.get(repositoryId);
        if (!member) {
            throw new Error(`Unknown fixture member: ${repositoryId}`);
        }
        return { ...member };
    }

    function enqueue({ repositoryId, method = 'GET', endpoint, response, error, handler }) {
        if (!memberMap.has(repositoryId)) {
            throw new Error(`Cannot enqueue route for unknown member: ${repositoryId}`);
        }
        if (typeof endpoint !== 'string' && !(endpoint instanceof RegExp) && typeof endpoint !== 'function') {
            throw new TypeError('Fixture endpoint must be a string, RegExp, or function.');
        }
        routes.push({
            repositoryId,
            method: method.toUpperCase(),
            endpoint,
            response,
            error,
            handler,
            consumed: false,
        });
    }

    async function request(memberContext, endpoint, options = {}) {
        const expected = memberMap.get(memberContext?.repositoryId);
        if (!expected) {
            throw new Error(`Unknown fixture member: ${memberContext?.repositoryId || '<missing>'}`);
        }
        if (String(memberContext.githubRepositoryId) !== String(expected.githubRepositoryId)) {
            throw new Error(`GitHub repository identity mismatch for ${memberContext.repositoryId}`);
        }

        const method = String(options.method || 'GET').toUpperCase();
        calls.push({
            repositoryId: expected.repositoryId,
            githubRepositoryId: String(expected.githubRepositoryId),
            method,
            endpoint,
            headers: redactHeaders(options.headers),
            hasBody: options.body !== undefined || options.json !== undefined,
        });

        const route = routes.find((candidate) => (
            !candidate.consumed
            && candidate.repositoryId === expected.repositoryId
            && candidate.method === method
            && matchesEndpoint(candidate.endpoint, endpoint)
        ));
        if (!route) {
            throw new Error(`No fixture response for ${expected.repositoryId} ${method} ${endpoint}`);
        }
        route.consumed = true;

        if (typeof route.handler === 'function') {
            return await route.handler({ member: getMember(expected.repositoryId), endpoint, options });
        }
        if (route.error) {
            throw route.error;
        }
        return cloneJson(route.response);
    }

    function assertNoSecrets(value = calls) {
        const serialized = JSON.stringify(value);
        for (const member of memberMap.values()) {
            if (member.token && serialized.includes(member.token)) {
                throw new Error(`Fixture output leaked token for ${member.repositoryId}`);
            }
        }
    }

    function pendingRoutes() {
        return routes.filter((route) => !route.consumed).length;
    }

    return {
        calls,
        enqueue,
        getMember,
        pendingRoutes,
        request,
        assertNoSecrets,
    };
}

module.exports = {
    REDACTED,
    createGitHubTransportFixture,
    createHttpError,
    createTimeoutError,
};
