'use strict';

function normalizeLedger(value) {
    if (value == null) return { version: 1, members: {} };
    if (value.version !== 1 || !value.members || typeof value.members !== 'object' || Array.isArray(value.members)) {
        throw new Error('Invalid repository pool orphan ledger.');
    }
    return JSON.parse(JSON.stringify(value));
}

function advanceCompleteScan(ledgerInput, { repositoryId, orphanKeys, scannedAt, graceMs }) {
    const ledger = normalizeLedger(ledgerInput);
    const nowMs = Date.parse(scannedAt);
    if (!repositoryId || !Number.isFinite(nowMs) || !Number.isFinite(graceMs) || graceMs < 0) {
        throw new TypeError('A complete maintenance scan needs a repository, time, and grace period.');
    }
    const previous = ledger.members[repositoryId]?.orphans || {};
    const orphans = {};
    const eligibleKeys = [];
    for (const key of Array.from(new Set(orphanKeys)).sort()) {
        const firstSeenAt = previous[key]?.firstSeenAt || scannedAt;
        orphans[key] = { firstSeenAt, lastSeenAt: scannedAt };
        if (previous[key] && nowMs - Date.parse(firstSeenAt) >= graceMs) eligibleKeys.push(key);
    }
    ledger.members[repositoryId] = {
        lastCompleteScanAt: scannedAt,
        orphans,
    };
    return { ledger, eligibleKeys };
}

function forgetDeletedOrphans(ledgerInput, repositoryId, keys) {
    const ledger = normalizeLedger(ledgerInput);
    const orphans = ledger.members[repositoryId]?.orphans;
    if (!orphans) return ledger;
    for (const key of keys) delete orphans[key];
    return ledger;
}

module.exports = { advanceCompleteScan, forgetDeletedOrphans, normalizeLedger };
