const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const archiver = require('archiver');
const express = require('express');
const yauzl = require('yauzl');

const info = {
    id: 'archive-reserve',
    name: 'Archive Reserve',
    description: '完整打包 SillyTavern data，并存入 GitHub Releases，支持整包或按路径恢复。',
    version: '0.1.3',
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_ROOT_DIR = path.join(process.cwd(), 'data');
const DEFAULT_USER_DATA_DIR = path.join(DATA_ROOT_DIR, 'default-user');
const BACKUP_DIR = fs.existsSync(DEFAULT_USER_DATA_DIR) ? DEFAULT_USER_DATA_DIR : DATA_ROOT_DIR;
const BACKUP_ROOT_LABEL = path.relative(process.cwd(), BACKUP_DIR).replace(/\\/g, '/') || 'data';
const STORAGE_DIR = path.join(DATA_ROOT_DIR, '.archive-reserve');
const CONFIG_PATH = path.join(STORAGE_DIR, 'config.json');
const LEGACY_STORAGE_CONFIG_PATH = path.join(DATA_ROOT_DIR, '_storage', info.id, 'config.json');
const LEGACY_CONFIG_PATH = path.join(__dirname, 'config.json');
const META_ASSET_NAME = 'archive-reserve.meta.json';
const ARCHIVE_FILE_NAME = 'archive-reserve.data.zip';
const ARCHIVE_PART_PREFIX = 'archive-reserve.data.zip.part';
const RELEASE_TAG_PREFIX = 'archive-reserve-';
const CHUNK_STORE_TAG = 'archivereserve-store-v1';
const CHUNK_STORE_NAME = 'Archive Reserve Chunk Store';
const CHUNK_ASSET_PREFIX = 'archive-reserve.chunk.';
const SECOND_LEVEL_CHUNK_ROOTS = new Set(['chats', 'assets', 'extensions', 'vectors', 'thumbnails']);
const USER_THIRD_LEVEL_CHUNK_ROOTS = new Set(['images', 'files']);
const CHUNK_GC_GRACE_MS = 6 * 60 * 60 * 1000;
const SPLIT_THRESHOLD_BYTES = 1800 * 1024 * 1024;
const GITHUB_API_ROOT = 'https://api.github.com';
const RETRYABLE_FETCH_ERROR_CODES = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
]);
const IGNORED_FILE_NAMES = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db']);
const IGNORED_DIRECTORY_NAMES = new Set(['.git']);

const DEFAULT_CONFIG = {
    repo: '',
    token: '',
    deviceId: '',
    deviceName: '',
    lastBackupAt: null,
    autoBackupEnabled: false,
    autoBackupIntervalMinutes: 240,
    autoBackupKeepCount: 12,
    manualBackupKeepCount: 0,
};

let currentOperation = null;
let currentProgress = null;
let autoBackupTimer = null;
let nextAutoBackupAt = null;
let lastAutoBackupResult = null;

function createId() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID().replace(/-/g, '');
    }
    return crypto.randomBytes(16).toString('hex');
}

function getDefaultDeviceName() {
    return os.hostname() || 'Unknown Device';
}

function trimToEmpty(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeviceName(value) {
    return trimToEmpty(value) || getDefaultDeviceName();
}

function normalizeAutoBackupInterval(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_CONFIG.autoBackupIntervalMinutes;
    }
    return Math.min(7 * 24 * 60, Math.max(15, Math.round(numeric)));
}

function normalizeAutoBackupKeepCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_CONFIG.autoBackupKeepCount;
    }
    return Math.min(200, Math.max(1, Math.round(numeric)));
}

function normalizeManualBackupKeepCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_CONFIG.manualBackupKeepCount;
    }
    return Math.min(200, Math.max(0, Math.round(numeric)));
}

function buildDefaultBackupName(date = new Date()) {
    const stamp = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const time = [
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
        String(date.getSeconds()).padStart(2, '0'),
    ].join('.');
    return `Archive ${stamp} ${time}`;
}

function buildError(message, statusCode = 400, details = '') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = details;
    return error;
}

async function getFetchFn() {
    if (typeof fetch === 'function') {
        return fetch;
    }
    throw buildError('当前 Node 环境不支持 fetch，Archive Reserve 需要 Node 18 以上。', 500);
}

function parseRepoInput(value) {
    const input = trimToEmpty(value);
    if (!input) {
        throw buildError('请填写 GitHub 仓库，例如 owner/repo。');
    }

    const trimmed = input.replace(/^github\.com\//i, 'https://github.com/');
    const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);

    let owner = '';
    let repo = '';

    if (urlMatch) {
        owner = urlMatch[1];
        repo = urlMatch[2];
    } else {
        const parts = input.replace(/\.git$/i, '').split('/').filter(Boolean);
        if (parts.length !== 2) {
            throw buildError('仓库格式不对。请填写 owner/repo 或完整 GitHub 链接。');
        }
        [owner, repo] = parts;
    }

    if (!owner || !repo) {
        throw buildError('仓库格式不对。请填写 owner/repo。');
    }

    return {
        owner,
        repo,
        slug: `${owner}/${repo}`,
    };
}

function normalizeRelativePath(input, { allowRoot = false } = {}) {
    if (typeof input !== 'string') {
        throw buildError('路径参数无效。');
    }

    const raw = input.replace(/\\/g, '/').trim();
    if (!raw || raw === '.' || raw === '/') {
        if (allowRoot) {
            return '';
        }
        throw buildError('路径不能为空。');
    }

    const normalized = path.posix.normalize(raw).replace(/^\/+/, '').replace(/\/+$/, '');

    if (!normalized || normalized === '.') {
        if (allowRoot) {
            return '';
        }
        throw buildError('路径不能为空。');
    }

    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw buildError(`路径越界：${input}`);
    }

    return normalized;
}

function normalizeArchiveEntryPath(input) {
    const raw = input.replace(/\\/g, '/').replace(/^\/+/, '');
    const stripped = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    return normalizeRelativePath(stripped);
}

function isSelectedPath(rootPath, targetPath) {
    if (!rootPath) {
        return true;
    }
    return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);
}

function collapseSelectedPaths(paths) {
    const normalized = Array.from(new Set((paths || []).map((item) => normalizeRelativePath(item, { allowRoot: true }))))
        .sort((left, right) => left.length - right.length);

    const collapsed = [];
    for (const candidate of normalized) {
        if (collapsed.some((existing) => isSelectedPath(existing, candidate))) {
            continue;
        }
        collapsed.push(candidate);
    }
    return collapsed;
}

function formatTokenPreview(value) {
    if (!value) {
        return '';
    }
    if (value.length <= 8) {
        return `${value.slice(0, 2)}...${value.slice(-2)}`;
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function toClientConfig(config) {
    return {
        repo: config.repo,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        hasToken: Boolean(config.token),
        tokenPreview: formatTokenPreview(config.token),
        lastBackupAt: config.lastBackupAt,
        autoBackupEnabled: Boolean(config.autoBackupEnabled),
        autoBackupIntervalMinutes: normalizeAutoBackupInterval(config.autoBackupIntervalMinutes),
        autoBackupKeepCount: normalizeAutoBackupKeepCount(config.autoBackupKeepCount),
        manualBackupKeepCount: normalizeManualBackupKeepCount(config.manualBackupKeepCount),
    };
}

function normalizeConfig(parsed) {
    return {
        ...DEFAULT_CONFIG,
        ...parsed,
        deviceId: parsed.deviceId || createId(),
        deviceName: parsed.deviceName || getDefaultDeviceName(),
        autoBackupEnabled: Boolean(parsed.autoBackupEnabled),
        autoBackupIntervalMinutes: normalizeAutoBackupInterval(parsed.autoBackupIntervalMinutes),
        autoBackupKeepCount: normalizeAutoBackupKeepCount(parsed.autoBackupKeepCount),
        manualBackupKeepCount: normalizeManualBackupKeepCount(parsed.manualBackupKeepCount),
    };
}

function setOperationState(label = '', progress = null) {
    currentOperation = label || null;
    if (!label) {
        currentProgress = null;
        return;
    }

    if (!progress) {
        currentProgress = {
            label,
            detail: '',
            current: 0,
            total: 0,
            percent: null,
        };
        return;
    }

    const current = Number(progress.current) || 0;
    const total = Number(progress.total) || 0;
    currentProgress = {
        label,
        detail: trimToEmpty(progress.detail),
        current,
        total,
        percent: total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : null,
    };
}

function buildStatusPayload(config) {
    return {
        configured: Boolean(config.repo && config.token),
        dataDirectory: BACKUP_DIR,
        backupRootLabel: BACKUP_ROOT_LABEL,
        currentOperation,
        progress: currentProgress,
        autoBackup: {
            enabled: Boolean(config.autoBackupEnabled),
            intervalMinutes: normalizeAutoBackupInterval(config.autoBackupIntervalMinutes),
            keepCount: normalizeAutoBackupKeepCount(config.autoBackupKeepCount),
            nextRunAt: nextAutoBackupAt,
            lastResult: lastAutoBackupResult,
        },
        manualBackupKeepCount: normalizeManualBackupKeepCount(config.manualBackupKeepCount),
    };
}

async function tryMigrateConfig(sourcePath, label) {
    try {
        const legacyContent = await fsp.readFile(sourcePath, 'utf8');
        const legacyParsed = JSON.parse(legacyContent);
        const migrated = normalizeConfig(legacyParsed);
        await saveConfig(migrated);
        console.log(`[archive-reserve] 已迁移${label}配置到 ${CONFIG_PATH}`);
        return migrated;
    } catch (error) {
        if (error.code && error.code !== 'ENOENT') {
            console.warn(`[archive-reserve] 读取${label}配置失败，将尝试其他位置：`, error.message);
        }
        return null;
    }
}

async function readConfig() {
    try {
        const content = await fsp.readFile(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(content);
        const next = normalizeConfig(parsed);
        let changed = false;

        if (!next.deviceId) {
            next.deviceId = createId();
            changed = true;
        }

        if (!next.deviceName) {
            next.deviceName = getDefaultDeviceName();
            changed = true;
        }

        if (changed) {
            await saveConfig(next);
        }

        return next;
    } catch (error) {
        if (error.code === 'ENOENT') {
            const storageMigrated = await tryMigrateConfig(LEGACY_STORAGE_CONFIG_PATH, '旧 _storage ');
            if (storageMigrated) {
                return storageMigrated;
            }

            const fileMigrated = await tryMigrateConfig(LEGACY_CONFIG_PATH, '旧插件目录');
            if (fileMigrated) {
                return fileMigrated;
            }
        }

        if (error.code && error.code !== 'ENOENT') {
            console.warn('[archive-reserve] 读取配置失败，将生成新配置：', error.message);
        }

        const initialConfig = {
            ...DEFAULT_CONFIG,
            deviceId: createId(),
            deviceName: getDefaultDeviceName(),
        };
        await saveConfig(initialConfig);
        return initialConfig;
    }
}

async function saveConfig(config) {
    await fsp.mkdir(STORAGE_DIR, { recursive: true });
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function clearAutoBackupTimer() {
    if (autoBackupTimer) {
        clearTimeout(autoBackupTimer);
        autoBackupTimer = null;
    }
    nextAutoBackupAt = null;
}

function ensureConfigured(config) {
    if (!trimToEmpty(config.repo)) {
        throw buildError('还没有配置 GitHub 仓库。');
    }
    if (!trimToEmpty(config.token)) {
        throw buildError('还没有配置 GitHub Token。');
    }
}

function normalizePathParts(relativePath = '') {
    return String(relativePath)
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean);
}

function isAllowedExtensionGitPath(relativePath = '') {
    const parts = normalizePathParts(relativePath);
    return parts.length >= 3
        && parts[0] === 'extensions'
        && parts[2] === '.git';
}

function shouldIgnoreRelativePath(relativePath, isDirectory = false) {
    const parts = normalizePathParts(relativePath);
    const name = parts[parts.length - 1] || '';

    if (isDirectory) {
        if (name !== '.git') {
            return IGNORED_DIRECTORY_NAMES.has(name);
        }
        return !isAllowedExtensionGitPath(relativePath);
    }

    return IGNORED_FILE_NAMES.has(name);
}

async function ensureDataDirectory() {
    try {
        const stat = await fsp.stat(BACKUP_DIR);
        if (!stat.isDirectory()) {
            throw buildError(`备份目录不存在：${BACKUP_DIR}`);
        }
    } catch (error) {
        if (error.statusCode) {
            throw error;
        }
        throw buildError(`找不到 SillyTavern 备份目录：${BACKUP_DIR}`);
    }
}

function resolveDataPath(relativePath = '') {
    return resolveRootedPath(BACKUP_DIR, relativePath);
}

function resolveRootedPath(rootDir, relativePath = '') {
    const base = path.resolve(rootDir);
    const target = path.resolve(base, relativePath);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
        throw buildError(`路径越界：${relativePath}`);
    }
    return target;
}

async function removeIfExists(relativePath) {
    await fsp.rm(resolveDataPath(relativePath), { recursive: true, force: true });
}

async function clearDataDirectory() {
    const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (shouldIgnoreRelativePath(entry.name, entry.isDirectory())) {
            continue;
        }
        await fsp.rm(path.join(BACKUP_DIR, entry.name), { recursive: true, force: true });
    }
}

async function ensureDirectoryExists(targetPath, ensuredDirectories = null) {
    const cacheKey = path.resolve(targetPath);
    if (ensuredDirectories?.has(cacheKey)) {
        return;
    }

    try {
        const stat = await fsp.lstat(targetPath);
        if (!stat.isDirectory()) {
            await fsp.rm(targetPath, { recursive: true, force: true });
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    await fsp.mkdir(targetPath, { recursive: true });
    ensuredDirectories?.add(cacheKey);
}

function sortDirEntries(entries) {
    return entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
}

async function collectDataEntries() {
    const entries = [];
    let fileCount = 0;
    let directoryCount = 0;
    let rawBytes = 0;

    async function walk(currentRelativePath = '') {
        const currentAbsolutePath = resolveDataPath(currentRelativePath);
        const dirEntries = sortDirEntries(await fsp.readdir(currentAbsolutePath, { withFileTypes: true }));

        for (const dirEntry of dirEntries) {
            const nextRelativePath = currentRelativePath
                ? path.posix.join(currentRelativePath, dirEntry.name)
                : dirEntry.name;

            if (shouldIgnoreRelativePath(nextRelativePath, dirEntry.isDirectory())) {
                continue;
            }

            if (dirEntry.isSymbolicLink()) {
                continue;
            }

            if (dirEntry.isDirectory()) {
                directoryCount += 1;
                entries.push({
                    path: nextRelativePath,
                    type: 'dir',
                    size: 0,
                    mtimeMs: 0,
                });
                await walk(nextRelativePath);
                continue;
            }

            if (!dirEntry.isFile()) {
                continue;
            }

            const stat = await fsp.stat(resolveDataPath(nextRelativePath));
            fileCount += 1;
            rawBytes += stat.size;
            entries.push({
                path: nextRelativePath,
                type: 'file',
                size: stat.size,
                mtimeMs: stat.mtimeMs,
            });
        }
    }

    await walk('');

    return {
        entries,
        stats: {
            fileCount,
            directoryCount,
            rawBytes,
        },
    };
}

async function listArchivableFiles(sourceDir) {
    const files = [];

    async function walk(currentRelativePath = '') {
        const currentAbsolutePath = resolveRootedPath(sourceDir, currentRelativePath);
        const dirEntries = sortDirEntries(await fsp.readdir(currentAbsolutePath, { withFileTypes: true }));

        for (const dirEntry of dirEntries) {
            const nextRelativePath = currentRelativePath
                ? path.posix.join(currentRelativePath, dirEntry.name)
                : dirEntry.name;

            if (shouldIgnoreRelativePath(nextRelativePath, dirEntry.isDirectory())) {
                continue;
            }

            if (dirEntry.isSymbolicLink()) {
                continue;
            }

            if (dirEntry.isDirectory()) {
                await walk(nextRelativePath);
                continue;
            }

            if (!dirEntry.isFile()) {
                continue;
            }

            files.push(nextRelativePath);
        }
    }

    await walk('');
    return files;
}

function getChunkRootPath(relativePath) {
    const parts = String(relativePath).split('/').filter(Boolean);
    const first = parts[0] || '';
    if (!first) {
        return '';
    }

    if (first === 'user' && parts.length > 1) {
        const second = parts[1];
        if (USER_THIRD_LEVEL_CHUNK_ROOTS.has(second) && parts.length > 2) {
            return `user/${second}/${parts[2]}`;
        }
        return `user/${second}`;
    }

    if (parts.length > 1 && SECOND_LEVEL_CHUNK_ROOTS.has(first)) {
        return `${first}/${parts[1]}`;
    }

    return first;
}

function createChunkId(rootPath, entries) {
    const hash = crypto.createHash('sha256');
    hash.update('archive-reserve-chunk-v1');
    hash.update('\0');
    hash.update(rootPath);
    hash.update('\0');

    const sortedEntries = entries.slice().sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN'));
    for (const entry of sortedEntries) {
        hash.update(`${entry.type}\0${entry.path}\0${entry.size}\0${entry.mtimeMs}\n`);
    }

    return hash.digest('hex');
}

function buildChunkGroups(collection) {
    const groups = new Map();

    for (const entry of collection.entries) {
        const rootPath = getChunkRootPath(entry.path);
        if (!rootPath) {
            continue;
        }

        let group = groups.get(rootPath);
        if (!group) {
            group = {
                rootPath,
                entries: [],
                stats: {
                    fileCount: 0,
                    directoryCount: 0,
                    rawBytes: 0,
                },
            };
            groups.set(rootPath, group);
        }

        group.entries.push(entry);
        if (entry.type === 'file') {
            group.stats.fileCount += 1;
            group.stats.rawBytes += entry.size;
        } else if (entry.type === 'dir') {
            group.stats.directoryCount += 1;
        }
    }

    return Array.from(groups.values())
        .sort((left, right) => left.rootPath.localeCompare(right.rootPath, 'zh-Hans-CN'))
        .map((group) => ({
            ...group,
            id: createChunkId(group.rootPath, group.entries),
        }));
}

function createHashingTransform() {
    const hash = crypto.createHash('sha256');
    let size = 0;

    const stream = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            size += chunk.length;
            callback(null, chunk);
        },
    });

    return {
        stream,
        getSummary() {
            return {
                size,
                sha256: hash.digest('hex'),
            };
        },
    };
}

async function createArchiveFromDirectory(sourceDir, outputPath) {
    await ensureDirectoryExists(path.dirname(outputPath));
    const fileEntries = await listArchivableFiles(sourceDir);

    return await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 3 } });
        const hashing = createHashingTransform();

        output.on('close', () => resolve(hashing.getSummary()));
        output.on('error', reject);
        hashing.stream.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', (error) => {
            if (error.code === 'ENOENT') {
                return;
            }
            reject(error);
        });

        archive.pipe(hashing.stream).pipe(output);
        for (const fileEntry of fileEntries) {
            archive.file(resolveRootedPath(sourceDir, fileEntry), { name: fileEntry });
        }
        archive.finalize();
    });
}

async function createArchive(outputPath) {
    return await createArchiveFromDirectory(BACKUP_DIR, outputPath);
}

async function createChunkArchive(group, outputPath) {
    await ensureDirectoryExists(path.dirname(outputPath));
    const fileEntries = group.entries.filter((entry) => entry.type === 'file');

    return await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 3 } });
        const hashing = createHashingTransform();

        output.on('close', () => resolve(hashing.getSummary()));
        output.on('error', reject);
        hashing.stream.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', (error) => {
            if (error.code === 'ENOENT') {
                return;
            }
            reject(error);
        });

        archive.pipe(hashing.stream).pipe(output);
        for (const fileEntry of fileEntries) {
            archive.file(resolveDataPath(fileEntry.path), { name: fileEntry.path });
        }

        archive.finalize();
    });
}

async function sha256File(filePath) {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(filePath);
        input.on('data', (chunk) => hash.update(chunk));
        input.on('error', reject);
        input.on('end', () => resolve(hash.digest('hex')));
    });
}

async function writeChunk(stream, chunk) {
    if (!stream.write(chunk)) {
        await new Promise((resolve, reject) => {
            stream.once('drain', resolve);
            stream.once('error', reject);
        });
    }
}

async function closeWriteStream(stream) {
    await new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.once('error', reject);
        stream.end();
    });
}

async function createPartState(workDir, index, baseName) {
    const name = `${baseName}.part${String(index).padStart(3, '0')}`;
    const partPath = path.join(workDir, name);
    return {
        index,
        name,
        path: partPath,
        size: 0,
        hash: crypto.createHash('sha256'),
        stream: fs.createWriteStream(partPath),
    };
}

async function finalizePartState(partState) {
    await closeWriteStream(partState.stream);
    return {
        index: partState.index,
        name: partState.name,
        path: partState.path,
        size: partState.size,
        sha256: partState.hash.digest('hex'),
    };
}

async function splitArchiveIfNeeded(archivePath, workDir, archiveSummary = null, assetBaseName = ARCHIVE_FILE_NAME) {
    const archiveSize = Number(archiveSummary?.size) || (await fsp.stat(archivePath)).size;

    if (archiveSize <= SPLIT_THRESHOLD_BYTES) {
        return {
            split: false,
            totalBytes: archiveSize,
            parts: [{
                index: 1,
                name: assetBaseName,
                path: archivePath,
                size: archiveSize,
                sha256: archiveSummary?.sha256 || await sha256File(archivePath),
            }],
        };
    }

    const parts = [];
    const input = fs.createReadStream(archivePath, { highWaterMark: 8 * 1024 * 1024 });
    let currentPart = await createPartState(workDir, 1, assetBaseName);

    for await (const chunk of input) {
        let offset = 0;

        while (offset < chunk.length) {
            const remaining = SPLIT_THRESHOLD_BYTES - currentPart.size;
            const nextSlice = chunk.subarray(offset, offset + remaining);
            currentPart.hash.update(nextSlice);
            await writeChunk(currentPart.stream, nextSlice);
            currentPart.size += nextSlice.length;
            offset += nextSlice.length;

            if (currentPart.size === SPLIT_THRESHOLD_BYTES) {
                parts.push(await finalizePartState(currentPart));
                currentPart = await createPartState(workDir, parts.length + 1, assetBaseName);
            }
        }
    }

    if (currentPart.size > 0) {
        parts.push(await finalizePartState(currentPart));
    } else {
        currentPart.stream.destroy();
        await fsp.rm(currentPart.path, { force: true });
    }

    return {
        split: true,
        totalBytes: archiveSize,
        parts,
    };
}

function buildReleaseTag(backupId) {
    return `${RELEASE_TAG_PREFIX}${Date.now()}-${backupId}`;
}

function buildBackupMeta({ backupId, tagName, name, note, createdAt, config, collection, storeRelease, chunkResults, automatic = false }) {
    const chunks = chunkResults.map((result) => result.chunk);
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.totalBytes, 0);
    const totalPartCount = chunks.reduce((sum, chunk) => sum + chunk.partCount, 0);
    const reusedChunkCount = chunkResults.filter((result) => result.reused).length;

    return {
        metaVersion: 2,
        backupId,
        tagName,
        name,
        note,
        automatic: Boolean(automatic),
        createdAt,
        plugin: {
            id: info.id,
            version: info.version,
        },
        device: {
            id: config.deviceId,
            name: config.deviceName,
        },
        chunkStore: {
            releaseId: storeRelease.id,
            tagName: storeRelease.tag_name,
            name: storeRelease.name,
        },
        archive: {
            format: 'zip',
            mode: 'chunked',
            thresholdBytes: SPLIT_THRESHOLD_BYTES,
            totalBytes,
            partCount: totalPartCount,
            chunkCount: chunks.length,
            reusedChunkCount,
        },
        stats: collection.stats,
        entries: collection.entries,
        chunks,
    };
}

function buildReleaseSummary(meta) {
    return {
        type: 'archive-reserve-backup',
        version: 2,
        backupId: meta.backupId,
        name: meta.name,
        note: meta.note,
        automatic: Boolean(meta.automatic),
        createdAt: meta.createdAt,
        device: meta.device,
        archive: {
            mode: meta.archive.mode,
            split: false,
            totalBytes: meta.archive.totalBytes,
            partCount: meta.archive.partCount,
            chunkCount: meta.archive.chunkCount,
            reusedChunkCount: meta.archive.reusedChunkCount,
        },
        stats: meta.stats,
    };
}

function serializeReleaseBody(summary) {
    return JSON.stringify(summary, null, 2);
}

function parseReleaseBody(body) {
    if (!body) {
        return null;
    }

    try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.type === 'archive-reserve-backup') {
            return parsed;
        }
    } catch (error) {
        return null;
    }

    return null;
}

function backupFromRelease(release) {
    if (!release || !release.tag_name || !release.tag_name.startsWith(RELEASE_TAG_PREFIX)) {
        return null;
    }

    const summary = parseReleaseBody(release.body);
    if (!summary) {
        return null;
    }

    const metaAsset = release.assets.find((asset) => asset.name === META_ASSET_NAME);
    if (!metaAsset) {
        return null;
    }

    return {
        releaseId: release.id,
        tagName: release.tag_name,
        name: summary.name || release.name || '未命名备份',
        note: summary.note || '',
        automatic: Boolean(summary.automatic || summary.note === '[自动备份]'),
        createdAt: summary.createdAt || release.created_at,
        device: summary.device || { id: 'unknown', name: 'Unknown Device' },
        archive: {
            mode: summary.archive?.mode || 'chunked',
            split: false,
            totalBytes: summary.archive?.totalBytes || 0,
            partCount: summary.archive?.partCount || 0,
            chunkCount: summary.archive?.chunkCount || 0,
        },
        stats: summary.stats || null,
        publishedAt: release.published_at || release.created_at,
        draft: Boolean(release.draft),
        prerelease: Boolean(release.prerelease),
        complete: true,
    };
}

async function makeTempDir(label) {
    return await fsp.mkdtemp(path.join(os.tmpdir(), `${info.id}-${label}-`));
}

async function removeDirectorySafe(targetPath) {
    try {
        await fsp.rm(targetPath, { recursive: true, force: true });
    } catch (error) {
        console.warn('[archive-reserve] 清理临时目录失败：', targetPath, error.message);
    }
}

function repoApiPath(config) {
    const repo = parseRepoInput(config.repo);
    return {
        repo,
        path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
    };
}

async function requestGitHub(config, endpoint, options = {}) {
    const fetchFn = await getFetchFn();
    const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API_ROOT}${endpoint}`;
    const method = options.method || 'GET';
    const headers = {
        accept: options.accept || 'application/vnd.github+json',
        'user-agent': 'archive-reserve',
        'x-github-api-version': '2022-11-28',
        ...(options.headers || {}),
    };

    if (config?.token) {
        headers.authorization = `Bearer ${config.token}`;
    }

    let body = options.body;
    if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers['content-type'] = 'application/json';
    }

    const maxAttempts = options.retryAttempts || ((method === 'GET' || method === 'HEAD') ? 3 : 1);
    let response = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            response = await fetchFn(url, {
                method,
                headers,
                body,
                redirect: 'follow',
                duplex: body && typeof body.pipe === 'function' ? 'half' : undefined,
            });
            break;
        } catch (error) {
            if (attempt < maxAttempts && isRetryableFetchError(error)) {
                await sleep(900 * attempt);
                continue;
            }
            throw translateGitHubNetworkError(error, options.action || buildGitHubActionLabel(method, endpoint));
        }
    }

    if (options.rawResponse) {
        return response;
    }

    const text = await response.text();
    let payload = null;

    if (text) {
        try {
            payload = JSON.parse(text);
        } catch (error) {
            payload = text;
        }
    }

    if (!response.ok) {
        const message = typeof payload === 'object' && payload?.message
            ? payload.message
            : `${response.status} ${response.statusText}`;
        throw buildError(`GitHub 请求失败：${message}`, response.status, typeof payload === 'string' ? payload : JSON.stringify(payload || {}));
    }

    return payload;
}

function buildGitHubActionLabel(method, endpoint) {
    const pathText = endpoint.startsWith('http')
        ? endpoint
        : endpoint.replace(/^\/repos\/[^/]+\/[^/]+/, '仓库');

    if (method === 'GET') {
        return `读取 ${pathText}`;
    }

    if (method === 'POST') {
        return `提交 ${pathText}`;
    }

    if (method === 'PUT') {
        return `写入 ${pathText}`;
    }

    if (method === 'DELETE') {
        return `删除 ${pathText}`;
    }

    return `请求 ${pathText}`;
}

function getFetchErrorCode(error) {
    return error?.cause?.code || error?.code || '';
}

function isRetryableFetchError(error) {
    return RETRYABLE_FETCH_ERROR_CODES.has(getFetchErrorCode(error));
}

function translateGitHubNetworkError(error, action) {
    const code = getFetchErrorCode(error);
    const reason = code || error?.cause?.message || error?.message || '未知网络错误';

    if (code === 'UND_ERR_CONNECT_TIMEOUT') {
        return buildError(`连接 GitHub 超时：${action}。请稍后重试。`, 502, reason);
    }

    if (code === 'UND_ERR_HEADERS_TIMEOUT') {
        return buildError(`GitHub 响应太慢：${action}。请稍后重试。`, 502, reason);
    }

    if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') {
        return buildError(`GitHub 连接中断：${action}。请稍后重试。`, 502, reason);
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return buildError(`GitHub 域名解析失败：${action}。请检查当前网络。`, 502, reason);
    }

    if (code === 'ETIMEDOUT') {
        return buildError(`请求 GitHub 超时：${action}。请稍后重试。`, 502, reason);
    }

    return buildError(`连接 GitHub 失败：${action}。请稍后重试。`, 502, reason);
}

function isEmptyRepositoryError(error) {
    const message = String(error?.message || '');
    const details = String(error?.details || '');
    return error?.statusCode === 409
        && (message.includes('Git Repository is empty') || details.includes('Git Repository is empty'));
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function initializeRepositoryContents(config, repoPath, defaultBranch) {
    const bootstrapContent = Buffer.from(`Archive Reserve initialized at ${new Date().toISOString()}\n`, 'utf8').toString('base64');
    const payload = {
        message: 'Initialize Archive Reserve repository',
        content: bootstrapContent,
    };

    if (defaultBranch) {
        payload.branch = defaultBranch;
    }

    return await requestGitHub(config, `${repoPath}/contents/.archive-reserve`, {
        method: 'PUT',
        json: payload,
    });
}

async function ensureRepositoryReady(config) {
    const repoInfoPath = repoApiPath(config);
    const repoInfo = await requestGitHub(config, repoInfoPath.path);
    const defaultBranch = repoInfo.default_branch || 'main';

    try {
        await requestGitHub(config, `${repoInfoPath.path}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
    } catch (error) {
        if (error.statusCode !== 404 && !isEmptyRepositoryError(error)) {
            throw error;
        }

        let lastBootstrapError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                await initializeRepositoryContents(config, repoInfoPath.path, defaultBranch);
                lastBootstrapError = null;
                break;
            } catch (bootstrapError) {
                lastBootstrapError = bootstrapError;
                if ((bootstrapError.statusCode === 409 || bootstrapError.statusCode === 422) && attempt < 3) {
                    await sleep(1200 * attempt);
                    continue;
                }
                break;
            }
        }

        if (lastBootstrapError) {
            throw buildError(
                '空仓库初始化失败。等几秒再试一次；如果仍失败，再手动给仓库加一个 README。',
                400,
                lastBootstrapError.details || lastBootstrapError.message,
            );
        }
    }

    return {
        ...repoInfoPath,
        defaultBranch,
    };
}

async function listAllReleases(config) {
    const { path: repoPath } = repoApiPath(config);
    const releases = [];
    let page = 1;

    while (true) {
        const pageItems = await requestGitHub(config, `${repoPath}/releases?per_page=100&page=${page}`);
        if (!Array.isArray(pageItems) || pageItems.length === 0) {
            break;
        }
        releases.push(...pageItems);
        if (pageItems.length < 100) {
            break;
        }
        page += 1;
    }

    return releases;
}

function buildUploadUrl(release, assetName) {
    const base = release.upload_url.replace(/\{.*$/, '');
    return `${base}?name=${encodeURIComponent(assetName)}`;
}

async function uploadReleaseAsset(config, release, assetName, filePath, contentType) {
    const fetchFn = await getFetchFn();
    const uploadUrl = buildUploadUrl(release, assetName);
    const stat = await fsp.stat(filePath);
    const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${config.token}`,
        'content-type': contentType,
        'content-length': String(stat.size),
        'user-agent': 'archive-reserve',
        'x-github-api-version': '2022-11-28',
    };

    let response = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            response = await fetchFn(uploadUrl, {
                method: 'POST',
                headers,
                body: fs.createReadStream(filePath),
                redirect: 'follow',
                duplex: 'half',
            });
            break;
        } catch (error) {
            if (attempt < 2 && isRetryableFetchError(error)) {
                await sleep(1200 * attempt);
                continue;
            }
            throw translateGitHubNetworkError(error, `上传 ${assetName}`);
        }
    }

    const text = await response.text();
    let payload = null;

    if (text) {
        try {
            payload = JSON.parse(text);
        } catch (error) {
            payload = text;
        }
    }

    if (!response.ok) {
        const message = typeof payload === 'object' && payload?.message
            ? payload.message
            : `${response.status} ${response.statusText}`;
        throw buildError(`上传 ${assetName} 失败：${message}`, response.status, typeof payload === 'string' ? payload : JSON.stringify(payload || {}));
    }

    return payload;
}

async function createRelease(config, repoState, releaseOptions) {
    return await requestGitHub(config, `${repoState.path}/releases`, {
        method: 'POST',
        json: {
            tag_name: releaseOptions.tagName,
            target_commitish: repoState.defaultBranch,
            name: releaseOptions.name,
            body: releaseOptions.body,
            draft: false,
            prerelease: false,
        },
    });
}

async function getReleaseByTag(config, tagName) {
    const { path: repoPath } = repoApiPath(config);
    return await requestGitHub(config, `${repoPath}/releases/tags/${encodeURIComponent(tagName)}`);
}

async function getRelease(config, releaseId) {
    const { path: repoPath } = repoApiPath(config);
    return await requestGitHub(config, `${repoPath}/releases/${releaseId}`);
}

async function deleteRelease(config, releaseId, tagName) {
    const { path: repoPath } = repoApiPath(config);
    await requestGitHub(config, `${repoPath}/releases/${releaseId}`, {
        method: 'DELETE',
    });

    try {
        await requestGitHub(config, `${repoPath}/git/refs/tags/${encodeURIComponent(tagName)}`, {
            method: 'DELETE',
        });
    } catch (error) {
        if (error.statusCode !== 404) {
            throw error;
        }
    }
}

async function deleteReleaseAsset(config, assetId) {
    const { path: repoPath } = repoApiPath(config);
    await requestGitHub(config, `${repoPath}/releases/assets/${assetId}`, {
        method: 'DELETE',
    });
}

async function safeDeleteRelease(config, releaseId, tagName) {
    try {
        await deleteRelease(config, releaseId, tagName);
    } catch (error) {
        console.warn('[archive-reserve] 清理失败的 release 失败：', error.message);
    }
}

function buildChunkAssetBaseName(chunkId) {
    return `${CHUNK_ASSET_PREFIX}${chunkId}.zip`;
}

function buildChunkAssetPartPrefix(chunkId) {
    return `${buildChunkAssetBaseName(chunkId)}.part`;
}

async function ensureChunkStoreRelease(config, repoState) {
    try {
        return await getReleaseByTag(config, CHUNK_STORE_TAG);
    } catch (error) {
        if (error.statusCode !== 404) {
            throw error;
        }
    }

    return await createRelease(config, repoState, {
        tagName: CHUNK_STORE_TAG,
        name: CHUNK_STORE_NAME,
        body: 'Archive Reserve hidden chunk store',
    });
}

function buildChunkRefFromAssets(chunkId, rootPath, groupStats, assets) {
    const sortedAssets = assets.slice().sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const isSplit = sortedAssets.length > 1 || sortedAssets[0]?.name.startsWith(buildChunkAssetPartPrefix(chunkId));
    const totalBytes = sortedAssets.reduce((sum, asset) => sum + (Number(asset.size) || 0), 0);

    return {
        id: chunkId,
        rootPath,
        format: 'zip',
        split: isSplit,
        totalBytes,
        partCount: sortedAssets.length,
        stats: {
            ...groupStats,
        },
        parts: sortedAssets.map((asset, index) => ({
            index: index + 1,
            name: asset.name,
            size: Number(asset.size) || 0,
            sha256: '',
        })),
    };
}

function findStoredChunk(storeRelease, chunkId, rootPath, groupStats) {
    const assets = Array.isArray(storeRelease?.assets) ? storeRelease.assets : [];
    const exactName = buildChunkAssetBaseName(chunkId);
    const exactAsset = assets.find((asset) => asset.name === exactName);
    if (exactAsset) {
        return buildChunkRefFromAssets(chunkId, rootPath, groupStats, [exactAsset]);
    }

    const partPrefix = buildChunkAssetPartPrefix(chunkId);
    const partAssets = assets.filter((asset) => asset.name.startsWith(partPrefix));
    if (partAssets.length > 0) {
        return buildChunkRefFromAssets(chunkId, rootPath, groupStats, partAssets);
    }

    return null;
}

function isChunkUploadConflictError(error) {
    if (!error) {
        return false;
    }
    if (error.statusCode === 409 || error.statusCode === 422) {
        return true;
    }
    const message = String(error.message || '');
    const details = String(error.details || '');
    return message.includes('already_exists')
        || details.includes('already_exists')
        || message.includes('already been taken')
        || details.includes('already been taken');
}

async function refreshChunkStoreRelease(config) {
    return await getReleaseByTag(config, CHUNK_STORE_TAG);
}

async function uploadChunkPartWithConflictRecovery(config, storeRelease, part, contentType) {
    let asset = storeRelease.assets.find((item) => item.name === part.name);
    if (asset) {
        return asset;
    }

    try {
        asset = await uploadReleaseAsset(config, storeRelease, part.name, part.path, contentType);
        storeRelease.assets.push(asset);
        return asset;
    } catch (error) {
        if (!isChunkUploadConflictError(error)) {
            throw error;
        }

        const freshStoreRelease = await refreshChunkStoreRelease(config);
        storeRelease.assets = Array.isArray(freshStoreRelease.assets) ? freshStoreRelease.assets.slice() : [];
        asset = storeRelease.assets.find((item) => item.name === part.name);
        if (asset) {
            return asset;
        }
        throw error;
    }
}

async function createOrReuseChunk(config, storeRelease, group, workDir, progress) {
    const existing = findStoredChunk(storeRelease, group.id, group.rootPath, group.stats);
    if (existing) {
        return {
            chunk: existing,
            reused: true,
        };
    }

    const assetBaseName = buildChunkAssetBaseName(group.id);
    const tempArchivePath = path.join(workDir, `${group.id}.zip`);

    progress && progress(`正在打包分块 ${group.rootPath}`);
    const archiveSummary = await createChunkArchive(group, tempArchivePath);
    const chunkPlan = await splitArchiveIfNeeded(tempArchivePath, workDir, archiveSummary, assetBaseName);

    const uploadedAssets = [];
    for (const part of chunkPlan.parts) {
        progress && progress(`正在上传分块 ${group.rootPath}`);
        const asset = await uploadChunkPartWithConflictRecovery(config, storeRelease, part, 'application/octet-stream');
        uploadedAssets.push({
            index: part.index,
            name: part.name,
            size: part.size,
            sha256: part.sha256,
        });
    }

    return {
        reused: false,
        chunk: {
            id: group.id,
            rootPath: group.rootPath,
            format: 'zip',
            split: chunkPlan.split,
            totalBytes: chunkPlan.totalBytes,
            partCount: chunkPlan.parts.length,
            stats: {
                ...group.stats,
            },
            parts: uploadedAssets,
        },
    };
}

async function downloadAssetToFile(config, asset, filePath) {
    const response = await requestGitHub(config, asset.url, {
        accept: 'application/octet-stream',
        rawResponse: true,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw buildError(`下载 ${asset.name} 失败：${response.status} ${response.statusText}`, response.status, errorText);
    }

    if (!response.body) {
        throw buildError(`下载 ${asset.name} 失败：GitHub 没有返回数据流。`, 502);
    }

    await ensureDirectoryExists(path.dirname(filePath));
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
    return await fsp.stat(filePath);
}

async function downloadAssetText(config, asset) {
    const response = await requestGitHub(config, asset.url, {
        accept: 'application/octet-stream',
        rawResponse: true,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw buildError(`下载 ${asset.name} 失败：${response.status} ${response.statusText}`, response.status, errorText);
    }

    return await response.text();
}

async function getBackupMeta(config, release) {
    const metaAsset = release.assets.find((asset) => asset.name === META_ASSET_NAME);
    if (!metaAsset) {
        throw buildError('这个备份缺少 meta.json，无法恢复。', 404);
    }

    const text = await downloadAssetText(config, metaAsset);

    try {
        return sanitizeMeta(JSON.parse(text));
    } catch (error) {
        if (error.statusCode) {
            throw error;
        }
        throw buildError('meta.json 解析失败。', 500, error.message);
    }
}

function sanitizeMeta(meta) {
    if (!meta || typeof meta !== 'object') {
        throw buildError('meta.json 结构无效。', 500);
    }

    if (!Array.isArray(meta.chunks) || meta.chunks.length === 0) {
        throw buildError('meta.json 缺少 chunks 描述。', 500);
    }

    const sanitizedEntries = Array.isArray(meta.entries)
        ? meta.entries.map((entry) => {
            if (!entry || typeof entry !== 'object') {
                throw buildError('meta.json 中存在无效条目。', 500);
            }

            if (entry.type !== 'file' && entry.type !== 'dir') {
                throw buildError(`meta.json 条目类型无效：${entry.type}`, 500);
            }

            return {
                path: normalizeRelativePath(String(entry.path || '')),
                type: entry.type,
                size: Number(entry.size) || 0,
                mtimeMs: Number(entry.mtimeMs) || 0,
            };
        })
        : [];

    const sanitizedChunks = meta.chunks.map((chunk, chunkIndex) => {
        if (!chunk || typeof chunk !== 'object') {
            throw buildError('meta.json 中存在无效分块信息。', 500);
        }

        const rootPath = normalizeRelativePath(String(chunk.rootPath || ''));
        const parts = Array.isArray(chunk.parts) ? chunk.parts : [];
        if (parts.length === 0) {
            throw buildError(`分块缺少资产：${rootPath}`, 500);
        }

        const sanitizedParts = parts.map((part, partIndex) => {
            if (!part || typeof part !== 'object') {
                throw buildError('meta.json 中存在无效分块资产。', 500);
            }

            const name = trimToEmpty(part.name);
            if (!name) {
                throw buildError('meta.json 中存在空分块资产名。', 500);
            }

            return {
                index: Number(part.index) || partIndex + 1,
                name,
                size: Number(part.size) || 0,
                sha256: trimToEmpty(part.sha256),
            };
        });

        return {
            id: trimToEmpty(chunk.id) || `chunk-${chunkIndex + 1}`,
            rootPath,
            format: 'zip',
            split: Boolean(chunk.split),
            totalBytes: Number(chunk.totalBytes) || sanitizedParts.reduce((sum, part) => sum + part.size, 0),
            partCount: Number(chunk.partCount) || sanitizedParts.length,
            stats: {
                fileCount: Number(chunk.stats?.fileCount) || sanitizedEntries.filter((entry) => entry.type === 'file' && isSelectedPath(rootPath, entry.path)).length,
                directoryCount: Number(chunk.stats?.directoryCount) || sanitizedEntries.filter((entry) => entry.type === 'dir' && isSelectedPath(rootPath, entry.path)).length,
                rawBytes: Number(chunk.stats?.rawBytes) || sanitizedEntries.reduce((sum, entry) => (
                    entry.type === 'file' && isSelectedPath(rootPath, entry.path) ? sum + entry.size : sum
                ), 0),
            },
            parts: sanitizedParts,
        };
    });

    const totalBytes = sanitizedChunks.reduce((sum, chunk) => sum + chunk.totalBytes, 0);
    const totalPartCount = sanitizedChunks.reduce((sum, chunk) => sum + chunk.parts.length, 0);

    return {
        ...meta,
        name: trimToEmpty(meta.name) || '未命名备份',
        note: trimToEmpty(meta.note),
        createdAt: trimToEmpty(meta.createdAt) || new Date().toISOString(),
        device: {
            id: trimToEmpty(meta.device?.id) || 'unknown-device',
            name: trimToEmpty(meta.device?.name) || 'Unknown Device',
        },
        chunkStore: {
            releaseId: Number(meta.chunkStore?.releaseId) || 0,
            tagName: trimToEmpty(meta.chunkStore?.tagName) || CHUNK_STORE_TAG,
            name: trimToEmpty(meta.chunkStore?.name) || CHUNK_STORE_NAME,
        },
        archive: {
            format: 'zip',
            mode: 'chunked',
            totalBytes: Number(meta.archive?.totalBytes) || totalBytes,
            partCount: Number(meta.archive?.partCount) || totalPartCount,
            chunkCount: Number(meta.archive?.chunkCount) || sanitizedChunks.length,
            reusedChunkCount: Number(meta.archive?.reusedChunkCount) || 0,
        },
        stats: {
            fileCount: Number(meta.stats?.fileCount) || sanitizedEntries.filter((entry) => entry.type === 'file').length,
            directoryCount: Number(meta.stats?.directoryCount) || sanitizedEntries.filter((entry) => entry.type === 'dir').length,
            rawBytes: Number(meta.stats?.rawBytes) || sanitizedEntries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0),
        },
        entries: sanitizedEntries,
        chunks: sanitizedChunks,
    };
}

function selectEntriesFromMeta(meta, selectedPaths) {
    const normalized = collapseSelectedPaths(selectedPaths);
    const selected = meta.entries.filter((entry) => normalized.some((root) => isSelectedPath(root, entry.path)));
    const files = selected.filter((entry) => entry.type === 'file');
    const directories = selected.filter((entry) => entry.type === 'dir');
    const chunks = meta.chunks.filter((chunk) => normalized.some((root) => isSelectedPath(root, chunk.rootPath) || isSelectedPath(chunk.rootPath, root)));
    return {
        selectedPaths: normalized,
        files,
        directories,
        chunks,
    };
}

function collectParentDirectories(fileEntries) {
    const directories = new Set();
    for (const entry of fileEntries) {
        const parts = entry.path.split('/');
        parts.pop();
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            directories.add(current);
        }
    }
    return directories;
}

async function prepareRestoreTarget(mode, selection) {
    if (mode === 'full') {
        await clearDataDirectory();
    } else if (mode === 'replace') {
        const selectedRoots = selection.selectedPaths.slice().sort((left, right) => right.length - left.length);
        for (const rootPath of selectedRoots) {
            await removeIfExists(rootPath);
        }
    }

    const requiredDirectories = new Set(selection.directories.map((entry) => entry.path));
    for (const parentPath of collectParentDirectories(selection.files)) {
        requiredDirectories.add(parentPath);
    }

    for (const directoryPath of Array.from(requiredDirectories).sort((left, right) => left.length - right.length)) {
        await ensureDirectoryExists(resolveDataPath(directoryPath));
    }
}

async function openZip(zipPath) {
    return await new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (error, zipFile) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(zipFile);
        });
    });
}

async function extractSelectedFiles(zipPath, fileEntries, targetRoot = BACKUP_DIR, options = {}) {
    if (!fileEntries.length) {
        return [];
    }

    const targetFiles = new Set(fileEntries.map((entry) => entry.path));
    const extractedFiles = new Set();
    const ensuredDirectories = new Set([path.resolve(targetRoot)]);
    const zipFile = await openZip(zipPath);

    await new Promise((resolve, reject) => {
        let settled = false;

        function finish(error) {
            if (settled) {
                return;
            }
            settled = true;
            try {
                zipFile.close();
            } catch (closeError) {
                // ignore close errors after settle
            }
            if (error) {
                reject(error);
                return;
            }

            if (!options.allowMissing && extractedFiles.size !== targetFiles.size) {
                const missingFiles = [...targetFiles].filter((target) => !extractedFiles.has(target));
                reject(buildError(`压缩包缺少这些文件：${missingFiles.join(', ')}`));
                return;
            }

            resolve();
        }

        zipFile.readEntry();

        zipFile.on('entry', (entry) => {
            const rawName = entry.fileName || '';
            if (rawName.endsWith('/')) {
                zipFile.readEntry();
                return;
            }

            let relativePath;
            try {
                relativePath = normalizeArchiveEntryPath(rawName);
            } catch (error) {
                finish(error);
                return;
            }

            if (!targetFiles.has(relativePath)) {
                zipFile.readEntry();
                return;
            }

            const outputPath = resolveRootedPath(targetRoot, relativePath);

            zipFile.openReadStream(entry, async (streamError, readStream) => {
                if (streamError) {
                    finish(streamError);
                    return;
                }

                try {
                    await ensureDirectoryExists(path.dirname(outputPath), ensuredDirectories);
                    try {
                        const currentStat = await fsp.lstat(outputPath);
                        if (currentStat.isDirectory()) {
                            await fsp.rm(outputPath, { recursive: true, force: true });
                        }
                    } catch (error) {
                        if (error.code !== 'ENOENT') {
                            throw error;
                        }
                    }
                    await pipeline(readStream, fs.createWriteStream(outputPath));
                    extractedFiles.add(relativePath);
                    if (extractedFiles.size === targetFiles.size) {
                        finish();
                        return;
                    }
                    zipFile.readEntry();
                } catch (error) {
                    finish(error);
                }
            });
        });

        zipFile.on('end', () => finish());
        zipFile.on('close', () => finish());
        zipFile.on('error', (error) => finish(error));
    });

    return Array.from(extractedFiles);
}

async function appendFileToStream(sourcePath, targetStream) {
    await new Promise((resolve, reject) => {
        const source = fs.createReadStream(sourcePath);

        source.on('error', reject);
        targetStream.on('error', reject);
        source.on('end', resolve);
        source.pipe(targetStream, { end: false });
    });
}

async function materializeStoredArchive(config, assetMap, archiveRef, workDir, outputName) {
    const archivePath = path.join(workDir, outputName);

    if (!archiveRef?.parts?.length) {
        throw buildError('备份缺少压缩包描述，无法恢复。', 500);
    }

    if (!archiveRef.split) {
        const part = archiveRef.parts[0];
        const asset = assetMap.get(part.name);
        if (!asset) {
            throw buildError(`找不到压缩包资产：${part.name}`);
        }

        await downloadAssetToFile(config, asset, archivePath);
        await validateDownloadedPart(archivePath, part);
        return archivePath;
    }

    const output = fs.createWriteStream(archivePath);

    try {
        for (const part of [...archiveRef.parts].sort((left, right) => left.index - right.index)) {
            const asset = assetMap.get(part.name);
            if (!asset) {
                throw buildError(`找不到分卷资产：${part.name}`);
            }

            const partPath = path.join(workDir, part.name);
            await downloadAssetToFile(config, asset, partPath);
            await validateDownloadedPart(partPath, part);
            await appendFileToStream(partPath, output);
            await fsp.rm(partPath, { force: true });
        }

        await closeWriteStream(output);
    } catch (error) {
        output.destroy();
        throw error;
    }

    const stat = await fsp.stat(archivePath);
    if (stat.size !== archiveRef.totalBytes) {
        throw buildError(`拼接后的压缩包大小不对。预期 ${archiveRef.totalBytes}，实际 ${stat.size}`);
    }

    return archivePath;
}

async function resolveChunkStoreRelease(config, meta) {
    if (meta.chunkStore?.releaseId) {
        try {
            return await getRelease(config, meta.chunkStore.releaseId);
        } catch (error) {
            if (error.statusCode !== 404) {
                throw error;
            }
        }
    }

    if (meta.chunkStore?.tagName) {
        return await getReleaseByTag(config, meta.chunkStore.tagName);
    }

    throw buildError('找不到分块仓库 release。', 500);
}

async function materializeChunkArchive(config, storeRelease, chunk, workDir) {
    const assetMap = new Map((storeRelease.assets || []).map((asset) => [asset.name, asset]));
    return await materializeStoredArchive(config, assetMap, chunk, workDir, `${chunk.id}.zip`);
}

async function materializeArchive(config, release, meta, workDir) {
    const releaseAssets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const archiveRef = {
        split: meta.archive.split,
        totalBytes: meta.archive.totalBytes,
        parts: meta.archive.parts,
    };
    return await materializeStoredArchive(config, releaseAssets, archiveRef, workDir, ARCHIVE_FILE_NAME);
}

async function validateDownloadedPart(filePath, expectedPart) {
    const stat = await fsp.stat(filePath);
    if (stat.size !== expectedPart.size) {
        throw buildError(`下载校验失败：${expectedPart.name} 大小不一致。`);
    }

    if (!trimToEmpty(expectedPart.sha256)) {
        return;
    }

    const digest = await sha256File(filePath);
    if (digest !== expectedPart.sha256) {
        throw buildError(`下载校验失败：${expectedPart.name} 哈希不一致。`);
    }
}

async function withExclusiveOperation(label, handler) {
    if (currentOperation) {
        throw buildError(`当前正在执行：${currentOperation}`, 409);
    }

    setOperationState(label);
    try {
        return await handler();
    } finally {
        setOperationState('');
    }
}

function parseReleaseId(rawValue) {
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
        throw buildError('releaseId 无效。');
    }
    return value;
}

function summarizeBackupForResponse(releaseId, tagName, summary, publishedAt) {
    return {
        releaseId,
        tagName,
        name: summary.name,
        note: summary.note,
        automatic: Boolean(summary.automatic),
        createdAt: summary.createdAt,
        device: summary.device,
        archive: summary.archive,
        stats: summary.stats,
        publishedAt,
        draft: false,
        prerelease: false,
    };
}

async function runBackupJob(config, options = {}) {
    ensureConfigured(config);
    await ensureDataDirectory();

    const name = trimToEmpty(options.name) || buildDefaultBackupName();
    const note = trimToEmpty(options.note);
    const createdAt = new Date().toISOString();
    const backupId = createId();
    const tagName = buildReleaseTag(backupId);
    const tempDir = await makeTempDir('backup');

    try {
        setOperationState('正在扫描备份目录');
        const collection = await collectDataEntries();
        const chunkGroups = buildChunkGroups(collection);
        setOperationState('正在准备分块仓库');
        const repoState = await ensureRepositoryReady(config);
        const storeRelease = await ensureChunkStoreRelease(config, repoState);
        const chunkResults = [];

        for (const [index, group] of chunkGroups.entries()) {
            const progress = (label) => {
                setOperationState(label, {
                    current: index + 1,
                    total: chunkGroups.length,
                    detail: group.rootPath,
                });
            };
            chunkResults.push(await createOrReuseChunk(config, storeRelease, group, tempDir, progress));
        }

        const meta = buildBackupMeta({
            backupId,
            tagName,
            name,
            note,
            createdAt,
            config,
            collection,
            storeRelease,
            chunkResults,
            automatic: Boolean(options.automatic),
        });
        const summary = buildReleaseSummary(meta);
        const metaPath = path.join(tempDir, META_ASSET_NAME);
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));

        const release = await createRelease(config, repoState, {
            tagName,
            name,
            body: serializeReleaseBody(summary),
        });

        try {
            setOperationState('正在上传备份索引', {
                current: 1,
                total: 1,
                detail: META_ASSET_NAME,
            });
            await uploadReleaseAsset(config, release, META_ASSET_NAME, metaPath, 'application/json');
        } catch (uploadError) {
            await safeDeleteRelease(config, release.id, tagName);
            throw uploadError;
        }

        config.lastBackupAt = createdAt;
        await saveConfig(config);

        if (!options.automatic) {
            await pruneManualBackups(config);
        }

        return summarizeBackupForResponse(release.id, tagName, summary, release.published_at || createdAt);
    } finally {
        await removeDirectorySafe(tempDir);
    }
}

async function listBackupReleases(config) {
    const releases = await listAllReleases(config);
    return releases
        .map(backupFromRelease)
        .filter(Boolean)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

async function deleteBackupRelease(config, backup) {
    await deleteRelease(config, backup.releaseId, backup.tagName);
}

async function collectReferencedChunkAssetNames(config, backups) {
    const referenced = new Set();

    for (const backup of backups) {
        try {
            const release = await getRelease(config, backup.releaseId);
            const meta = await getBackupMeta(config, release);
            for (const chunk of meta.chunks || []) {
                for (const part of chunk.parts || []) {
                    referenced.add(part.name);
                }
            }
        } catch (error) {
            console.warn('[archive-reserve] 读取备份索引用于分块回收失败：', backup.tagName, error.message);
        }
    }

    return referenced;
}

function isChunkAssetGraceProtected(asset) {
    const timestamp = Date.parse(asset?.updated_at || asset?.created_at || '');
    if (!Number.isFinite(timestamp)) {
        return false;
    }
    return timestamp >= (Date.now() - CHUNK_GC_GRACE_MS);
}

function summarizeChunkAssets(assets) {
    return assets.reduce((summary, asset) => {
        summary.count += 1;
        summary.bytes += Number(asset.size) || 0;
        return summary;
    }, { count: 0, bytes: 0 });
}

async function getSpaceStats(config) {
    const releases = await listAllReleases(config);
    const backups = releases
        .map(backupFromRelease)
        .filter(Boolean)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    let storeRelease = null;
    try {
        storeRelease = await getReleaseByTag(config, CHUNK_STORE_TAG);
    } catch (error) {
        if (error.statusCode !== 404) {
            throw error;
        }
    }

    const referencedAssetNames = await collectReferencedChunkAssetNames(config, backups);
    const storeAssets = Array.isArray(storeRelease?.assets) ? storeRelease.assets : [];
    const referencedAssets = storeAssets.filter((asset) => referencedAssetNames.has(asset.name));
    const orphanAssets = storeAssets.filter((asset) => !referencedAssetNames.has(asset.name));
    const protectedAssets = orphanAssets.filter(isChunkAssetGraceProtected);
    const reclaimableAssets = orphanAssets.filter((asset) => !isChunkAssetGraceProtected(asset));
    const backupAssetBytes = releases.reduce((sum, release) => {
        if (!release.tag_name || !release.tag_name.startsWith(RELEASE_TAG_PREFIX)) {
            return sum;
        }
        return sum + (release.assets || []).reduce((inner, asset) => inner + (Number(asset.size) || 0), 0);
    }, 0);

    return {
        backups: {
            totalCount: backups.length,
            manualCount: backups.filter((backup) => !backup.automatic).length,
            automaticCount: backups.filter((backup) => backup.automatic).length,
            metaBytes: backupAssetBytes,
        },
        chunkStore: {
            exists: Boolean(storeRelease),
            releaseId: storeRelease?.id || 0,
            total: summarizeChunkAssets(storeAssets),
            referenced: summarizeChunkAssets(referencedAssets),
            protected: summarizeChunkAssets(protectedAssets),
            reclaimable: summarizeChunkAssets(reclaimableAssets),
        },
        gcGraceHours: Math.round(CHUNK_GC_GRACE_MS / (60 * 60 * 1000)),
        checkedAt: new Date().toISOString(),
    };
}

async function runBackupHealthCheck(config, releaseId) {
    const release = await getRelease(config, releaseId);
    const meta = await getBackupMeta(config, release);
    const storeRelease = await resolveChunkStoreRelease(config, meta);
    const assetMap = new Map((storeRelease.assets || []).map((asset) => [asset.name, asset]));
    const issues = [];

    for (const chunk of meta.chunks || []) {
        for (const part of chunk.parts || []) {
            const asset = assetMap.get(part.name);
            if (!asset) {
                issues.push(`缺少分块资产：${part.name}`);
                continue;
            }
            if ((Number(asset.size) || 0) !== (Number(part.size) || 0)) {
                issues.push(`分块大小不一致：${part.name}`);
            }
        }
    }

    return {
        checkedAt: new Date().toISOString(),
        healthy: issues.length === 0,
        issueCount: issues.length,
        issues,
        backup: backupFromRelease(release),
        stats: {
            fileCount: meta.stats.fileCount,
            chunkCount: meta.chunks.length,
            partCount: meta.archive.partCount,
        },
    };
}

async function pruneChunkStoreAssets(config) {
    let storeRelease;
    try {
        storeRelease = await getReleaseByTag(config, CHUNK_STORE_TAG);
    } catch (error) {
        if (error.statusCode === 404) {
            return {
                deletedCount: 0,
            };
        }
        throw error;
    }

    const backups = await listBackupReleases(config);
    const referencedAssetNames = await collectReferencedChunkAssetNames(config, backups);
    const orphanAssets = (storeRelease.assets || []).filter((asset) => !referencedAssetNames.has(asset.name));
    const protectedAssets = orphanAssets.filter(isChunkAssetGraceProtected);
    const reclaimableAssets = orphanAssets.filter((asset) => !isChunkAssetGraceProtected(asset));

    for (const asset of reclaimableAssets) {
        await deleteReleaseAsset(config, asset.id);
    }

    return {
        deletedCount: reclaimableAssets.length,
        deletedBytes: reclaimableAssets.reduce((sum, asset) => sum + (Number(asset.size) || 0), 0),
        protectedCount: protectedAssets.length,
        protectedBytes: protectedAssets.reduce((sum, asset) => sum + (Number(asset.size) || 0), 0),
    };
}

async function pruneBackups(config, { automatic, keepCount }) {
    if (keepCount <= 0) {
        return {
            keepCount,
            deletedCount: 0,
            gcDeletedCount: 0,
            gcProtectedCount: 0,
        };
    }

    const backups = (await listBackupReleases(config))
        .filter((backup) => backup.automatic === automatic)
        .filter((backup) => backup.device?.id === config.deviceId);

    const staleBackups = backups.slice(keepCount);
    for (const backup of staleBackups) {
        await deleteBackupRelease(config, backup);
    }

    const gcResult = staleBackups.length > 0
        ? await pruneChunkStoreAssets(config)
        : { deletedCount: 0 };

    return {
        keepCount,
        deletedCount: staleBackups.length,
        gcDeletedCount: gcResult.deletedCount,
        gcProtectedCount: gcResult.protectedCount,
    };
}

async function pruneAutoBackups(config) {
    const keepCount = normalizeAutoBackupKeepCount(config.autoBackupKeepCount);
    return await pruneBackups(config, {
        automatic: true,
        keepCount,
    });
}

async function pruneManualBackups(config) {
    const keepCount = normalizeManualBackupKeepCount(config.manualBackupKeepCount);
    return await pruneBackups(config, {
        automatic: false,
        keepCount,
    });
}

async function scheduleAutoBackup(config) {
    clearAutoBackupTimer();

    if (!config || !config.autoBackupEnabled || !trimToEmpty(config.repo) || !trimToEmpty(config.token)) {
        return;
    }

    const intervalMinutes = normalizeAutoBackupInterval(config.autoBackupIntervalMinutes);
    const delayMs = intervalMinutes * 60 * 1000;
    nextAutoBackupAt = new Date(Date.now() + delayMs).toISOString();

    autoBackupTimer = setTimeout(async () => {
        autoBackupTimer = null;
        nextAutoBackupAt = null;

        try {
            const latestConfig = await readConfig();
            if (currentOperation) {
                lastAutoBackupResult = {
                    ok: false,
                    at: new Date().toISOString(),
                    message: '跳过：当前已有任务在执行',
                };
            } else if (latestConfig.autoBackupEnabled) {
                await withExclusiveOperation('正在执行自动备份', async () => {
                    await runBackupJob(latestConfig, {
                        note: '[自动备份]',
                        automatic: true,
                    });
                });
                const pruneResult = await pruneAutoBackups(latestConfig);
                lastAutoBackupResult = {
                    ok: true,
                    at: new Date().toISOString(),
                    message: pruneResult.deletedCount > 0
                        ? `自动备份完成，已清理 ${pruneResult.deletedCount} 个旧自动快照${pruneResult.gcDeletedCount > 0 ? `，回收 ${pruneResult.gcDeletedCount} 个旧分块` : ''}`
                        : `自动备份完成${pruneResult.gcProtectedCount > 0 ? `，有 ${pruneResult.gcProtectedCount} 个新分块暂缓回收` : ''}`,
                };
            }
        } catch (error) {
            console.error('[archive-reserve] 自动备份失败：', error);
            lastAutoBackupResult = {
                ok: false,
                at: new Date().toISOString(),
                message: error.message || '自动备份失败',
            };
        } finally {
            try {
                const latestConfig = await readConfig();
                await scheduleAutoBackup(latestConfig);
            } catch (error) {
                console.error('[archive-reserve] 自动备份重新调度失败：', error);
            }
        }
    }, delayMs);
}

function asyncRoute(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.error('[archive-reserve] 请求失败：', error);
            res.status(error.statusCode || 500).json({
                ok: false,
                message: error.message || '未知错误',
                details: error.details || '',
            });
        }
    };
}

const plugin = {
    info,
    init: async (router) => {
        console.log('[archive-reserve] UI 路径: /api/plugins/archive-reserve/ui');

        router.use(express.json({ limit: '2mb' }));
        router.use('/static', express.static(PUBLIC_DIR));

        router.get('/ui', (req, res) => {
            res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
        });

        router.get('/config', asyncRoute(async (req, res) => {
            const config = await readConfig();
            res.json({
                ok: true,
                config: toClientConfig(config),
                status: buildStatusPayload(config),
            });
        }));

        router.get('/status', asyncRoute(async (req, res) => {
            const config = await readConfig();
            res.json({
                ok: true,
                ...buildStatusPayload(config),
            });
        }));

        router.get('/maintenance/space', asyncRoute(async (req, res) => {
            const config = await readConfig();
            ensureConfigured(config);

            res.json({
                ok: true,
                stats: await getSpaceStats(config),
            });
        }));

        router.post('/maintenance/gc', asyncRoute(async (req, res) => {
            const result = await withExclusiveOperation('正在回收空间', async () => {
                const config = await readConfig();
                ensureConfigured(config);
                return await pruneChunkStoreAssets(config);
            });

            res.json({
                ok: true,
                result,
            });
        }));

        router.post('/config', asyncRoute(async (req, res) => {
            const current = await readConfig();
            const repoInput = trimToEmpty(req.body?.repo);
            const tokenInput = trimToEmpty(req.body?.token);

            const nextConfig = {
                ...current,
                repo: repoInput ? parseRepoInput(repoInput).slug : current.repo,
                deviceName: normalizeDeviceName(req.body?.deviceName || current.deviceName),
                autoBackupEnabled: Boolean(req.body?.autoBackupEnabled),
                autoBackupIntervalMinutes: normalizeAutoBackupInterval(req.body?.autoBackupIntervalMinutes),
                autoBackupKeepCount: normalizeAutoBackupKeepCount(req.body?.autoBackupKeepCount),
                manualBackupKeepCount: normalizeManualBackupKeepCount(req.body?.manualBackupKeepCount),
            };

            if (tokenInput) {
                nextConfig.token = tokenInput;
            }

            await saveConfig(nextConfig);
            await scheduleAutoBackup(nextConfig);

            res.json({
                ok: true,
                config: toClientConfig(nextConfig),
            });
        }));

        router.get('/backups', asyncRoute(async (req, res) => {
            const config = await readConfig();
            if (!config.repo || !config.token) {
                res.json({
                    ok: true,
                    configured: false,
                    backups: [],
                    currentOperation,
                });
                return;
            }

            const releases = await listAllReleases(config);
            const backups = releases
                .map(backupFromRelease)
                .filter(Boolean)
                .filter((backup) => backup.complete)
                .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

            res.json({
                ok: true,
                configured: true,
                backups,
                currentOperation,
                progress: currentProgress,
            });
        }));

        router.post('/backups', asyncRoute(async (req, res) => {
            const result = await withExclusiveOperation('正在创建备份', async () => {
                const config = await readConfig();
                return await runBackupJob(config, {
                    name: req.body?.name,
                    note: req.body?.note,
                });
            });

            res.json({
                ok: true,
                backup: result,
            });
        }));

        router.get('/backups/:releaseId/tree', asyncRoute(async (req, res) => {
            const config = await readConfig();
            ensureConfigured(config);

            const releaseId = parseReleaseId(req.params.releaseId);
            const release = await getRelease(config, releaseId);
            const meta = await getBackupMeta(config, release);

            res.json({
                ok: true,
                releaseId,
                backup: backupFromRelease(release),
                meta,
            });
        }));

        router.post('/backups/:releaseId/check', asyncRoute(async (req, res) => {
            const result = await withExclusiveOperation('正在检查备份健康', async () => {
                const config = await readConfig();
                ensureConfigured(config);
                const releaseId = parseReleaseId(req.params.releaseId);
                return await runBackupHealthCheck(config, releaseId);
            });

            res.json({
                ok: true,
                result,
            });
        }));

        router.post('/backups/:releaseId/restore', asyncRoute(async (req, res) => {
            await withExclusiveOperation('正在恢复备份', async () => {
                const config = await readConfig();
                ensureConfigured(config);
                await ensureDataDirectory();

                const releaseId = parseReleaseId(req.params.releaseId);
                const mode = trimToEmpty(req.body?.mode) || 'full';
                if (!['full', 'merge', 'replace'].includes(mode)) {
                    throw buildError('恢复模式无效。');
                }

                const release = await getRelease(config, releaseId);
                const meta = await getBackupMeta(config, release);
                const tempDir = await makeTempDir('restore');

                try {
                    const selection = mode === 'full'
                        ? {
                            selectedPaths: [''],
                            files: meta.entries.filter((entry) => entry.type === 'file'),
                            directories: meta.entries.filter((entry) => entry.type === 'dir'),
                            chunks: meta.chunks,
                        }
                        : selectEntriesFromMeta(meta, req.body?.selectedPaths || []);

                    if (mode !== 'full' && selection.selectedPaths.length === 0) {
                        throw buildError('至少选择一个要恢复的路径。');
                    }

                    await prepareRestoreTarget(mode, selection);
                    const storeRelease = await resolveChunkStoreRelease(config, meta);
                    let remainingFiles = selection.files.slice();

                    for (const [index, chunk] of selection.chunks.entries()) {
                        if (remainingFiles.length === 0) {
                            break;
                        }

                        setOperationState('正在下载恢复分块', {
                            current: index + 1,
                            total: selection.chunks.length,
                            detail: chunk.rootPath,
                        });
                        const chunkPath = await materializeChunkArchive(config, storeRelease, chunk, tempDir);
                        setOperationState('正在恢复分块', {
                            current: index + 1,
                            total: selection.chunks.length,
                            detail: chunk.rootPath,
                        });
                        const extractedPaths = await extractSelectedFiles(chunkPath, remainingFiles, BACKUP_DIR, {
                            allowMissing: true,
                        });
                        const extractedSet = new Set(extractedPaths);
                        remainingFiles = remainingFiles.filter((entry) => !extractedSet.has(entry.path));
                        await fsp.rm(chunkPath, { force: true });
                    }

                    if (remainingFiles.length > 0) {
                        throw buildError(`压缩包缺少这些文件：${remainingFiles.map((entry) => entry.path).join(', ')}`);
                    }
                } finally {
                    await removeDirectorySafe(tempDir);
                }
            });

            res.json({
                ok: true,
                message: '恢复完成。',
            });
        }));

        router.get('/backups/:releaseId/download', async (req, res) => {
            try {
                await withExclusiveOperation('正在准备下载备份', async () => {
                    const config = await readConfig();
                    ensureConfigured(config);

                    const releaseId = parseReleaseId(req.params.releaseId);
                    const release = await getRelease(config, releaseId);
                    const meta = await getBackupMeta(config, release);
                    const tempDir = await makeTempDir('download');
                    const stagingDir = path.join(tempDir, 'data');

                    try {
                        await ensureDirectoryExists(stagingDir);
                        const storeRelease = await resolveChunkStoreRelease(config, meta);
                        let remainingFiles = meta.entries.filter((entry) => entry.type === 'file');

                        for (const [index, chunk] of meta.chunks.entries()) {
                            if (remainingFiles.length === 0) {
                                break;
                            }

                            setOperationState('正在下载备份分块', {
                                current: index + 1,
                                total: meta.chunks.length,
                                detail: chunk.rootPath,
                            });
                            const chunkPath = await materializeChunkArchive(config, storeRelease, chunk, tempDir);
                            setOperationState('正在整理下载包', {
                                current: index + 1,
                                total: meta.chunks.length,
                                detail: chunk.rootPath,
                            });
                            const extractedPaths = await extractSelectedFiles(chunkPath, remainingFiles, stagingDir, {
                                allowMissing: true,
                            });
                            const extractedSet = new Set(extractedPaths);
                            remainingFiles = remainingFiles.filter((entry) => !extractedSet.has(entry.path));
                            await fsp.rm(chunkPath, { force: true });
                        }

                        if (remainingFiles.length > 0) {
                            throw buildError(`压缩包缺少这些文件：${remainingFiles.map((entry) => entry.path).join(', ')}`);
                        }

                        const outputPath = path.join(tempDir, ARCHIVE_FILE_NAME);
                        setOperationState('正在打包下载文件', {
                            current: 1,
                            total: 1,
                            detail: meta.name,
                        });
                        await createArchiveFromDirectory(stagingDir, outputPath);

                        const downloadName = `${meta.name.replace(/[<>:"/\\|?*]+/g, '_') || 'Archive Reserve backup'}.zip`;
                        res.setHeader('Content-Type', 'application/zip');
                        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
                        await pipeline(fs.createReadStream(outputPath), res);
                    } finally {
                        await removeDirectorySafe(tempDir);
                    }
                });
            } catch (error) {
                console.error('[archive-reserve] 请求失败：', error);
                if (!res.headersSent) {
                    res.status(error.statusCode || 500).json({
                        ok: false,
                        message: error.message || '未知错误',
                        details: error.details || '',
                    });
                } else {
                    res.end();
                }
            }
        });

        router.delete('/backups/:releaseId', asyncRoute(async (req, res) => {
            await withExclusiveOperation('正在删除备份', async () => {
                const config = await readConfig();
                ensureConfigured(config);

                const releaseId = parseReleaseId(req.params.releaseId);
                const release = await getRelease(config, releaseId);
                await deleteRelease(config, releaseId, release.tag_name);
                await pruneChunkStoreAssets(config);
            });

            res.json({
                ok: true,
                message: '备份已删除。',
            });
        }));

        const startupConfig = await readConfig();
        await scheduleAutoBackup(startupConfig);
    },
    exit: async () => {
        clearAutoBackupTimer();
    },
};

module.exports = plugin;
