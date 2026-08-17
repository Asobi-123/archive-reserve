'use strict';

function collectRequiredDirectories(selection) {
    const directories = new Set((selection.directories || []).map((entry) => entry.path));
    for (const entry of selection.files || []) {
        const parts = entry.path.split('/');
        parts.pop();
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            directories.add(current);
        }
    }
    return Array.from(directories).sort((left, right) => left.length - right.length);
}

function assertStagingComplete(remainingFiles) {
    if (remainingFiles.length > 0) {
        throw Object.assign(
            new Error(`恢复临时区缺少这些文件：${remainingFiles.map((entry) => entry.path).join(', ')}`),
            { statusCode: 409 },
        );
    }
    return true;
}

module.exports = { assertStagingComplete, collectRequiredDirectories };
