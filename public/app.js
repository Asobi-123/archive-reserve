const API_BASE = '/api/plugins/archive-reserve';
const TAB_STATE_KEY = 'archive-reserve.active-tab.v1';
const THEME_STATE_KEY = 'archive-reserve.theme.v1';

const state = {
    config: null,
    backups: [],
    backupsLoaded: false,
    backupsLoading: false,
    backupsError: '',
    configured: false,
    currentOperation: '',
    currentProgress: null,
    activeTab: 'library',
    activeTheme: 'sand',
    activeDevice: 'all',
    backupSearchQuery: '',
    csrfToken: '',
    operationPollTimer: null,
    backupRootLabel: '',
    autoBackup: null,
    spaceStats: null,
    spaceStatsState: 'idle',
    spaceStatsError: '',
    modal: {
        releaseId: null,
        backup: null,
        meta: null,
        searchQuery: '',
    },
};

const elements = {};

document.addEventListener('DOMContentLoaded', () => {
    cacheElements();
    bindEvents();
    initializeTheme();
    initializeTabState();
    void bootstrap();
});

function cacheElements() {
    elements.statusPill = document.getElementById('status-pill');
    elements.statusText = document.getElementById('status-text');
    elements.progressPanel = document.getElementById('progress-panel');
    elements.progressLabel = document.getElementById('progress-label');
    elements.progressPercent = document.getElementById('progress-percent');
    elements.progressFill = document.getElementById('progress-fill');
    elements.progressDetail = document.getElementById('progress-detail');
    elements.configForm = document.getElementById('config-form');
    elements.repoInput = document.getElementById('repo-input');
    elements.tokenInput = document.getElementById('token-input');
    elements.deviceNameInput = document.getElementById('device-name-input');
    elements.autoBackupEnabledInput = document.getElementById('auto-backup-enabled-input');
    elements.autoBackupIntervalInput = document.getElementById('auto-backup-interval-input');
    elements.autoBackupKeepInput = document.getElementById('auto-backup-keep-input');
    elements.manualBackupKeepInput = document.getElementById('manual-backup-keep-input');
    elements.themeButtons = Array.from(document.querySelectorAll('.theme-btn'));
    elements.autoBackupStatus = document.getElementById('auto-backup-status');
    elements.tokenHint = document.getElementById('token-hint');
    elements.backupRootHint = document.getElementById('backup-root-hint');
    elements.backupForm = document.getElementById('backup-form');
    elements.backupNameInput = document.getElementById('backup-name-input');
    elements.backupNoteInput = document.getElementById('backup-note-input');
    elements.backupList = document.getElementById('backup-list');
    elements.backupSearchInput = document.getElementById('backup-search-input');
    elements.backupSearchMeta = document.getElementById('backup-search-meta');
    elements.spaceStats = document.getElementById('space-stats');
    elements.refreshSpaceButton = document.getElementById('refresh-space-btn');
    elements.runGcButton = document.getElementById('run-gc-btn');
    elements.tabButtons = Array.from(document.querySelectorAll('.ar-tab'));
    elements.tabPages = Array.from(document.querySelectorAll('.tab-page'));
    elements.deviceFilter = document.getElementById('device-filter');
    elements.refreshButton = document.getElementById('refresh-btn');
    elements.restoreModal = document.getElementById('restore-modal');
    elements.closeModalButton = document.getElementById('close-modal-btn');
    elements.restoreTree = document.getElementById('restore-tree');
    elements.treeMeta = document.getElementById('tree-meta');
    elements.treeSearchInput = document.getElementById('tree-search-input');
    elements.treeSearchMeta = document.getElementById('tree-search-meta');
    elements.modalTitle = document.getElementById('modal-title');
    elements.saveConfigButton = document.getElementById('save-config-btn');
    elements.createBackupButton = document.getElementById('create-backup-btn');
    elements.confirmRestoreButton = document.getElementById('confirm-restore-btn');
    elements.checkAllButton = document.getElementById('check-all-btn');
    elements.clearAllButton = document.getElementById('clear-all-btn');
    elements.toastHost = document.getElementById('toast-host');
}

function bindEvents() {
    elements.configForm.addEventListener('submit', onSaveConfig);
    elements.backupForm.addEventListener('submit', onCreateBackup);
    elements.refreshButton.addEventListener('click', () => {
        void refreshBackupsWithFeedback();
    });
    elements.refreshSpaceButton.addEventListener('click', () => {
        void refreshSpaceStatsWithFeedback();
    });
    elements.runGcButton.addEventListener('click', () => {
        void runManualGc();
    });
    elements.themeButtons.forEach((button) => {
        button.addEventListener('click', () => {
            applyTheme(button.dataset.themeId || 'sand');
        });
    });
    elements.tabButtons.forEach((button) => {
        button.addEventListener('click', () => {
            setActiveTab(button.dataset.arTab);
        });
    });
    elements.deviceFilter.addEventListener('change', (event) => {
        state.activeDevice = event.target.value;
        renderBackupList();
    });
    elements.backupSearchInput.addEventListener('input', (event) => {
        state.backupSearchQuery = normalizeSearchQuery(event.target.value);
        renderBackupList();
    });
    elements.backupList.addEventListener('click', onBackupListClick);
    elements.closeModalButton.addEventListener('click', closeRestoreModal);
    elements.restoreModal.addEventListener('click', (event) => {
        if (event.target.dataset.closeModal === 'true') {
            closeRestoreModal();
        }
    });
    elements.restoreTree.addEventListener('change', onTreeChange);
    elements.treeSearchInput.addEventListener('input', onTreeSearchInput);
    elements.checkAllButton.addEventListener('click', () => selectAllTree(true));
    elements.clearAllButton.addEventListener('click', () => selectAllTree(false));
    elements.confirmRestoreButton.addEventListener('click', () => {
        void onConfirmSelectiveRestore();
    });
    window.addEventListener('resize', syncBackupActionMenus);
}

async function bootstrap() {
    setStatus('读取配置中', true);
    try {
        await ensureCsrfToken();
        await loadConfig();
        await ensureActiveTabData();
    } catch (error) {
        showToast(error.message || '初始化失败', 'error');
        setStatus(error.message || '初始化失败', false);
    }
}

function setStatus(text, busy = false) {
    elements.statusText.textContent = text;
    elements.statusPill.textContent = busy ? '处理中' : '待命';
    elements.statusPill.classList.toggle('busy', busy);
    renderProgress();
    syncInteractivity();
    syncOperationPolling();
}

function readActiveTab() {
    try {
        return localStorage.getItem(TAB_STATE_KEY) || 'library';
    } catch (error) {
        return 'library';
    }
}

function readTheme() {
    try {
        return localStorage.getItem(THEME_STATE_KEY) || 'sand';
    } catch (error) {
        return 'sand';
    }
}

function writeTheme(themeId) {
    try {
        localStorage.setItem(THEME_STATE_KEY, themeId);
    } catch (error) {
        console.warn('保存主题失败', error);
    }
}

function initializeTheme() {
    applyTheme(readTheme());
}

function applyTheme(themeId) {
    const nextTheme = themeId || 'sand';
    state.activeTheme = nextTheme;
    document.documentElement.dataset.arTheme = nextTheme === 'sand' ? '' : nextTheme;
    elements.themeButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.themeId === nextTheme);
    });
    writeTheme(nextTheme);
}

function writeActiveTab(tabId) {
    try {
        localStorage.setItem(TAB_STATE_KEY, tabId);
    } catch (error) {
        console.warn('保存标签状态失败', error);
    }
}

function initializeTabState() {
    setActiveTab(readActiveTab(), { skipLoad: true });
}

function setActiveTab(tabId, options = {}) {
    const { skipLoad = false } = options;
    const target = tabId || 'library';
    state.activeTab = target;
    elements.tabButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.arTab === target);
    });
    elements.tabPages.forEach((page) => {
        page.classList.toggle('active', page.dataset.arPage === target);
    });
    writeActiveTab(target);
    if (!skipLoad) {
        void ensureActiveTabData();
    }
}

function openTabForAction(tabId) {
    if (!tabId) {
        return;
    }
    if (state.activeTab !== tabId) {
        setActiveTab(tabId);
    }
}

async function ensureActiveTabData() {
    try {
        if (state.activeTab === 'library') {
            await ensureBackupsLoaded();
            return;
        }

        if (state.activeTab === 'maintenance') {
            renderSpaceStats();
        }
    } catch (error) {
        showToast(error.message || '读取档案库失败', 'error');
        setStatus(error.message || '读取档案库失败', false);
    }
}

function renderProgress() {
    const progress = state.currentProgress;
    const visible = Boolean(progress && state.currentOperation);
    elements.progressPanel.classList.toggle('hidden', !visible);
    elements.progressPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (!visible) {
        elements.progressLabel.textContent = '';
        elements.progressPercent.textContent = '';
        elements.progressFill.style.width = '0%';
        elements.progressDetail.textContent = '';
        return;
    }

    elements.progressLabel.textContent = progress.label || state.currentOperation;
    elements.progressPercent.textContent = progress.percent == null ? '' : `${progress.percent}%`;
    elements.progressFill.style.width = progress.percent == null ? '18%' : `${progress.percent}%`;
    elements.progressDetail.textContent = progress.detail
        || (progress.total > 0 ? `进度 ${progress.current}/${progress.total}` : '');
}

function renderAutoBackupStatus() {
    const autoBackup = state.autoBackup;
    if (!autoBackup || !state.config) {
        elements.autoBackupStatus.textContent = '';
        return;
    }

    if (!state.config.autoBackupEnabled) {
        elements.autoBackupStatus.textContent = '当前未启用自动备份。';
        return;
    }

    const nextRunText = autoBackup.nextRunAt ? `下次计划：${formatDate(autoBackup.nextRunAt)}` : '下次计划：等待调度';
    const hours = Math.max(1, Math.round((Number(state.config.autoBackupIntervalMinutes) || 240) / 60));
    const keepCount = Number(state.config.autoBackupKeepCount) || 12;
    const manualKeepCount = Number(state.config.manualBackupKeepCount) || 0;
    const lastResultText = autoBackup.lastResult?.at
        ? `上次结果：${formatDate(autoBackup.lastResult.at)} ${autoBackup.lastResult.message || ''}`.trim()
        : '还没有自动备份记录';
    elements.autoBackupStatus.textContent = `当前间隔：每 ${hours} 小时；自动档案保留 ${keepCount} 个；手动档案保留 ${manualKeepCount || '不限'}；${nextRunText}；${lastResultText}`;
}

function showToast(message, type = 'default') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`.trim();
    toast.textContent = message;
    elements.toastHost.appendChild(toast);
    window.setTimeout(() => {
        toast.remove();
    }, 3200);
}

async function loadSpaceStats(quiet = false) {
    state.spaceStatsState = 'loading';
    state.spaceStatsError = '';
    renderSpaceStats();

    try {
        const result = await apiRequest('/maintenance/space');
        state.spaceStats = result.stats || null;
        state.spaceStatsState = 'loaded';
        renderSpaceStats();
        return true;
    } catch (error) {
        state.spaceStats = null;
        state.spaceStatsState = 'error';
        state.spaceStatsError = error.message || '读取空间统计失败';
        renderSpaceStats();
        if (!quiet) {
            showToast(error.message || '读取空间统计失败', 'error');
        }
        return false;
    }
}

async function refreshSpaceStatsWithFeedback() {
    openTabForAction('maintenance');
    if (isBusy()) {
        showToast(`当前正在执行：${state.currentOperation}`, 'error');
        return;
    }

    const ok = await loadSpaceStats();
    if (ok && state.spaceStats) {
        const reclaimable = state.spaceStats.chunkStore?.reclaimable?.count || 0;
        if (reclaimable > 0) {
            showToast(`空间统计已刷新，当前可回收 ${reclaimable} 个孤儿分块`, 'success');
            return;
        }
        showToast('空间统计已刷新，当前没有可回收的孤儿分块', 'success');
    }
}

function renderSpaceStats() {
    const stats = state.spaceStats;
    if (!state.configured) {
        elements.spaceStats.innerHTML = '<div class="empty-state">先保存 GitHub 仓库设置，再查看维护数据。</div>';
        return;
    }

    if (state.spaceStatsState === 'loading') {
        elements.spaceStats.innerHTML = '<div class="empty-state">正在读取空间统计，请稍等。</div>';
        return;
    }

    if (state.spaceStatsState === 'error') {
        elements.spaceStats.innerHTML = `
            <div class="empty-state">
                <strong>读取空间统计失败</strong>
                <p>${escapeHtml(state.spaceStatsError || '请稍后重试。')}</p>
                <p>可以再次点击“刷新空间”重试。</p>
            </div>
        `;
        return;
    }

    if (!stats) {
        elements.spaceStats.innerHTML = `
            <div class="space-empty-state">
                <strong>维护页默认不自动深扫仓库</strong>
                <p>点击“刷新空间”后，才会统计当前仓库占用、有效引用和可回收分块。</p>
                <p>这样可以减少页面初次打开时的额外内存和网络压力。</p>
            </div>
        `;
        return;
    }

    elements.spaceStats.innerHTML = `
        <div class="space-grid">
            <article class="space-card">
                <h3>档案总览</h3>
                <p>总数 ${stats.backups.totalCount} 个，手动 ${stats.backups.manualCount} 个，自动 ${stats.backups.automaticCount} 个。</p>
                <p>备份索引约 ${formatBytes(stats.backups.metaBytes)}。</p>
            </article>
            <article class="space-card">
                <h3>分块仓库</h3>
                <p>总分块 ${stats.chunkStore.total.count} 个，占用 ${formatBytes(stats.chunkStore.total.bytes)}。</p>
                <p>有效引用 ${stats.chunkStore.referenced.count} 个，可回收 ${stats.chunkStore.reclaimable.count} 个。</p>
            </article>
            <article class="space-card">
                <h3>回收保护</h3>
                <p>新上传宽限 ${stats.gcGraceHours} 小时。</p>
                <p>当前保护 ${stats.chunkStore.protected.count} 个，占用 ${formatBytes(stats.chunkStore.protected.bytes)}。</p>
            </article>
            <article class="space-card">
                <h3>可立即回收</h3>
                <p>${stats.chunkStore.reclaimable.count} 个孤儿分块。</p>
                <p>${formatBytes(stats.chunkStore.reclaimable.bytes)}</p>
            </article>
        </div>
        <div class="space-meta">统计时间：${escapeHtml(formatDate(stats.checkedAt))}</div>
    `;
}

function invalidateSpaceStats() {
    state.spaceStats = null;
    state.spaceStatsState = 'idle';
    state.spaceStatsError = '';
    renderSpaceStats();
}

async function runManualGc() {
    openTabForAction('maintenance');
    if (isBusy()) {
        showToast(`当前正在执行：${state.currentOperation}`, 'error');
        return;
    }

    setOperation('正在回收空间');
    try {
        const result = await apiRequest('/maintenance/gc', {
            method: 'POST',
        });
        await loadSpaceStats(true);
        state.backupsLoaded = false;
        if (state.activeTab === 'library') {
            await loadBackups();
        }
        showToast(`已回收 ${result.result.deletedCount} 个分块，释放 ${formatBytes(result.result.deletedBytes || 0)}`, 'success');
    } catch (error) {
        if (isBusyError(error)) {
            await handleBusyError(error);
            return;
        }
        state.currentOperation = '';
        showToast(error.message || '手动回收失败', 'error');
        setStatus(error.message || '手动回收失败', false);
    }
}

async function apiRequest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        await ensureCsrfToken();
    }

    const response = await fetch(`${API_BASE}${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
            ...(state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {}),
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    let payload = {};

    if (text) {
        try {
            payload = JSON.parse(text);
        } catch (error) {
            payload = { ok: false, message: text };
        }
    }

    if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || `${response.status} ${response.statusText}`);
    }

    return payload;
}

async function ensureCsrfToken(force = false) {
    if (state.csrfToken && !force) {
        return state.csrfToken;
    }

    const response = await fetch('/csrf-token', {
        method: 'GET',
        credentials: 'same-origin',
    });

    if (!response.ok) {
        throw new Error('获取 CSRF token 失败，请刷新页面后再试。');
    }

    const payload = await response.json();
    if (!payload?.token) {
        throw new Error('服务器没有返回 CSRF token。');
    }

    state.csrfToken = payload.token;
    return state.csrfToken;
}

async function loadConfig() {
    const result = await apiRequest('/config');
    state.config = result.config;
    state.configured = Boolean(result.status?.configured);
    state.currentOperation = result.status?.currentOperation || '';
    state.currentProgress = result.status?.progress || null;
    state.backupRootLabel = result.status?.backupRootLabel || '';
    state.autoBackup = result.status?.autoBackup || null;
    state.backups = [];
    state.backupsLoaded = false;
    state.backupsLoading = false;
    state.backupsError = '';
    state.spaceStats = null;
    state.spaceStatsState = 'idle';
    state.spaceStatsError = '';

    elements.repoInput.value = result.config.repo || '';
    elements.deviceNameInput.value = result.config.deviceName || '';
    elements.autoBackupEnabledInput.checked = Boolean(result.config.autoBackupEnabled);
    elements.autoBackupIntervalInput.value = String(result.config.autoBackupIntervalMinutes || 240);
    elements.autoBackupKeepInput.value = String(result.config.autoBackupKeepCount || 12);
    elements.manualBackupKeepInput.value = String(result.config.manualBackupKeepCount || 0);
    elements.tokenInput.value = '';
    elements.tokenHint.textContent = result.config.hasToken
        ? `当前已保存 token：${result.config.tokenPreview}`
        : '当前还没有保存 token';
    elements.backupRootHint.textContent = state.backupRootLabel
        ? `当前备份根目录：${state.backupRootLabel}。自动排除 .gitkeep / .DS_Store；扩展目录的 .git 会一并保留。`
        : '';
    renderAutoBackupStatus();

    if (state.currentOperation) {
        setStatus(state.currentOperation, true);
    } else if (state.configured) {
        setStatus('设置已保存，可以直接创建或恢复备份', false);
    } else {
        setStatus('先把仓库和 token 填好', false);
    }

    renderDeviceFilter();
    renderBackupList();
    renderSpaceStats();
}

async function ensureBackupsLoaded() {
    if (!state.configured || state.backupsLoaded || state.backupsLoading) {
        renderBackupList();
        return;
    }

    await loadBackups();
}

async function loadBackups() {
    if (state.backupsLoading) {
        return;
    }

    state.backupsLoading = true;
    state.backupsError = '';
    renderBackupList();

    try {
        const result = await apiRequest('/backups');
        state.backups = result.backups || [];
        state.configured = Boolean(result.configured);
        state.currentOperation = result.currentOperation || '';
        state.currentProgress = result.progress || null;
        state.backupsLoaded = state.configured;
        state.backupsError = '';

        renderDeviceFilter();
        renderBackupList();

        if (state.currentOperation) {
            setStatus(state.currentOperation, true);
            return;
        }

        if (!state.configured) {
            setStatus('先把仓库和 token 填好', false);
            return;
        }

        setStatus(`已加载 ${state.backups.length} 个备份`, false);
    } catch (error) {
        state.backupsLoaded = false;
        state.backupsError = error.message || '读取档案库失败';
        renderDeviceFilter();
        renderBackupList();
        throw error;
    } finally {
        state.backupsLoading = false;
        renderBackupList();
    }
}

async function refreshBackupsWithFeedback() {
    openTabForAction('library');
    try {
        await loadBackups();
    } catch (error) {
        showToast(error.message || '读取档案库失败', 'error');
        setStatus(error.message || '读取档案库失败', false);
    }
}

async function loadStatus() {
    const result = await apiRequest('/status');
    state.currentOperation = result.currentOperation || '';
    state.configured = Boolean(result.configured);
    state.currentProgress = result.progress || null;
    state.autoBackup = result.autoBackup || state.autoBackup;
    renderAutoBackupStatus();
    return result;
}

function renderDeviceFilter() {
    if (!state.backupsLoaded) {
        elements.deviceFilter.innerHTML = '<option value="all">全部设备</option>';
        return;
    }

    const devices = new Map();
    for (const backup of state.backups) {
        devices.set(backup.device.id, backup.device.name);
    }

    const options = ['<option value="all">全部设备</option>'];
    for (const [deviceId, deviceName] of Array.from(devices.entries()).sort((left, right) => left[1].localeCompare(right[1], 'zh-Hans-CN'))) {
        const selected = state.activeDevice === deviceId ? 'selected' : '';
        options.push(`<option value="${escapeHtml(deviceId)}" ${selected}>${escapeHtml(deviceName)}</option>`);
    }

    elements.deviceFilter.innerHTML = options.join('');

    if (state.activeDevice !== 'all' && !devices.has(state.activeDevice)) {
        state.activeDevice = 'all';
        elements.deviceFilter.value = 'all';
    }
}

function getVisibleBackups() {
    const query = state.backupSearchQuery;
    return state.backups.filter((backup) => {
        if (state.activeDevice !== 'all' && backup.device.id !== state.activeDevice) {
            return false;
        }

        if (!query) {
            return true;
        }

        const haystack = [
            backup.name,
            backup.note,
            backup.device?.name,
            backup.tagName,
        ].join('\n').toLocaleLowerCase('zh-CN');
        return haystack.includes(query);
    });
}

function renderBackupList() {
    if (!state.configured) {
        elements.backupSearchMeta.textContent = '';
        elements.backupList.innerHTML = '<div class="empty-state">还没有配置 GitHub 仓库。</div>';
        return;
    }

    if (state.backupsLoading) {
        elements.backupSearchMeta.textContent = '';
        elements.backupList.innerHTML = '<div class="empty-state">正在读取档案库，请稍等。</div>';
        return;
    }

    if (!state.backupsLoaded) {
        elements.backupSearchMeta.textContent = '';
        elements.backupList.innerHTML = state.backupsError
            ? `<div class="empty-state">读取档案库失败：${escapeHtml(state.backupsError)}。可以点击“刷新列表”重试。</div>`
            : '<div class="empty-state">进入档案库后才会加载备份列表。</div>';
        return;
    }

    const visibleBackups = getVisibleBackups();
    elements.backupSearchMeta.textContent = state.backupSearchQuery
        ? `搜索后显示 ${visibleBackups.length} 个档案。`
        : '';
    if (!visibleBackups.length) {
        elements.backupList.innerHTML = '<div class="empty-state">当前筛选下没有备份。</div>';
        return;
    }

    elements.backupList.innerHTML = visibleBackups.map((backup) => `
        <article class="backup-card">
            <div class="backup-main">
                <h3>${escapeHtml(backup.name)}</h3>
                <p class="backup-note">${escapeHtml(backup.note || '无备注')}</p>
                <div class="backup-meta">
                    <span class="meta-chip">设备：${escapeHtml(backup.device.name)}</span>
                    <span class="meta-chip">时间：${escapeHtml(formatDate(backup.createdAt))}</span>
                    <span class="meta-chip">体积：${escapeHtml(formatBytes(backup.archive.totalBytes))}</span>
                    <span class="meta-chip">分卷：${backup.archive.partCount} 份</span>
                </div>
            </div>
            <div class="backup-actions">
                <div class="backup-action-primary">
                    <button class="btn btn-secondary" type="button" data-action="select-restore" data-release-id="${backup.releaseId}">选择恢复</button>
                    <button class="btn btn-secondary" type="button" data-action="full-restore" data-release-id="${backup.releaseId}">整包恢复</button>
                </div>
                <details class="backup-action-menu">
                    <summary class="backup-action-summary">更多操作</summary>
                    <div class="backup-action-secondary">
                        <button class="btn btn-secondary" type="button" data-action="check-backup" data-release-id="${backup.releaseId}">检查</button>
                        <button class="btn btn-secondary" type="button" data-action="download-backup" data-release-id="${backup.releaseId}">下载</button>
                        <button class="btn btn-secondary" type="button" data-action="delete-backup" data-release-id="${backup.releaseId}">删除</button>
                    </div>
                </details>
            </div>
        </article>
    `).join('');
    syncBackupActionMenus();
    syncInteractivity();
}

function syncBackupActionMenus() {
    const desktop = window.innerWidth > 960;
    elements.backupList.querySelectorAll('.backup-action-menu').forEach((menu) => {
        menu.open = desktop;
    });
}

function isBusy() {
    return Boolean(state.currentOperation);
}

function syncInteractivity() {
    const locked = isBusy();

    elements.repoInput.disabled = locked;
    elements.tokenInput.disabled = locked;
    elements.deviceNameInput.disabled = locked;
    elements.autoBackupEnabledInput.disabled = locked;
    elements.autoBackupIntervalInput.disabled = locked;
    elements.autoBackupKeepInput.disabled = locked;
    elements.manualBackupKeepInput.disabled = locked;
    elements.saveConfigButton.disabled = locked;
    elements.backupNameInput.disabled = locked;
    elements.backupNoteInput.disabled = locked;
    elements.createBackupButton.disabled = locked;
    elements.deviceFilter.disabled = locked;
    elements.backupSearchInput.disabled = locked;
    elements.refreshButton.disabled = locked;
    elements.refreshSpaceButton.disabled = locked;
    elements.runGcButton.disabled = locked;
    elements.checkAllButton.disabled = locked;
    elements.clearAllButton.disabled = locked;
    elements.confirmRestoreButton.disabled = locked;
    elements.treeSearchInput.disabled = locked;

    elements.backupList.querySelectorAll('button[data-action]').forEach((button) => {
        button.disabled = locked;
    });

    elements.restoreTree.querySelectorAll('.tree-check').forEach((checkbox) => {
        checkbox.disabled = locked;
    });
}

function syncOperationPolling() {
    if (state.operationPollTimer) {
        window.clearTimeout(state.operationPollTimer);
        state.operationPollTimer = null;
    }

    if (!isBusy()) {
        return;
    }

    state.operationPollTimer = window.setTimeout(() => {
        void refreshOperationState();
    }, 4000);
}

async function refreshOperationState() {
    try {
        await loadStatus();
        if (state.currentOperation) {
            setStatus(state.currentOperation, true);
            return;
        }

        try {
            await loadBackups();
        } catch (error) {
            state.backupsLoading = false;
            state.backupsLoaded = false;
            state.backupsError = error.message || '刷新备份列表失败';
            renderBackupList();
            console.error('刷新备份列表失败', error);
            setStatus('操作已结束，但刷新列表失败。点“刷新列表”重试。', false);
            showToast(error.message || '刷新备份列表失败', 'error');
        }
    } catch (error) {
        console.error('刷新操作状态失败', error);
        syncOperationPolling();
    }
}

function setOperation(label = '') {
    state.currentOperation = label;
    state.currentProgress = label
        ? {
            label,
            detail: '',
            current: 0,
            total: 0,
            percent: null,
        }
        : null;
    if (label) {
        setStatus(label, true);
        return;
    }

    if (!state.configured) {
        setStatus('先把仓库和 token 填好', false);
        return;
    }

    setStatus(`已加载 ${state.backups.length} 个备份`, false);
}

function isBusyError(error) {
    return typeof error?.message === 'string' && error.message.startsWith('当前正在执行：');
}

async function handleBusyError(error) {
    const currentLabel = error.message.replace('当前正在执行：', '').trim();
    setOperation(currentLabel || '处理中');
    showToast(error.message, 'error');
    await refreshOperationState();
}

async function onSaveConfig(event) {
    event.preventDefault();
    openTabForAction('config');
    if (isBusy()) {
        showToast(`当前正在执行：${state.currentOperation}`, 'error');
        return;
    }

    setOperation('保存设置中');

    try {
        await apiRequest('/config', {
            method: 'POST',
            body: {
                repo: elements.repoInput.value,
                token: elements.tokenInput.value,
                deviceName: elements.deviceNameInput.value,
                autoBackupEnabled: elements.autoBackupEnabledInput.checked,
                autoBackupIntervalMinutes: elements.autoBackupIntervalInput.value,
                autoBackupKeepCount: elements.autoBackupKeepInput.value,
                manualBackupKeepCount: elements.manualBackupKeepInput.value,
            },
        });

        await loadConfig();
        if (state.activeTab === 'library') {
            await loadBackups();
        }
        showToast('设置已保存', 'success');
    } catch (error) {
        if (isBusyError(error)) {
            await handleBusyError(error);
            return;
        }

        state.currentOperation = '';
        showToast(error.message || '保存设置失败', 'error');
        setStatus(error.message || '保存设置失败', false);
    }
}

async function onCreateBackup(event) {
    event.preventDefault();
    openTabForAction('create');
    if (isBusy()) {
        showToast(`当前正在执行：${state.currentOperation}`, 'error');
        return;
    }

    setOperation('正在创建备份');

    try {
        await apiRequest('/backups', {
            method: 'POST',
            body: {
                name: elements.backupNameInput.value,
                note: elements.backupNoteInput.value,
            },
        });

        elements.backupNameInput.value = '';
        elements.backupNoteInput.value = '';
        await loadConfig();
        state.backupsLoaded = false;
        if (state.activeTab === 'library') {
            await loadBackups();
        } else {
            renderBackupList();
        }
        invalidateSpaceStats();
        showToast('备份已创建', 'success');
    } catch (error) {
        if (isBusyError(error)) {
            await handleBusyError(error);
            return;
        }

        state.currentOperation = '';
        showToast(error.message || '创建备份失败', 'error');
        setStatus(error.message || '创建备份失败', false);
    }
}

async function onBackupListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
        return;
    }

    openTabForAction('library');
    const releaseId = Number(button.dataset.releaseId);
    const action = button.dataset.action;

    if (action === 'check-backup') {
        if (isBusy()) {
            showToast(`当前正在执行：${state.currentOperation}`, 'error');
            return;
        }

        setOperation('正在检查备份健康');
        try {
            const result = await apiRequest(`/backups/${releaseId}/check`, {
                method: 'POST',
            });
            state.currentOperation = '';
            setStatus(result.result.healthy ? '健康检查通过' : '健康检查发现问题', false);
            showToast(
                result.result.healthy
                    ? '健康检查通过'
                    : `发现 ${result.result.issueCount} 个问题：${result.result.issues[0] || '请稍后查看日志'}`,
                result.result.healthy ? 'success' : 'error',
            );
        } catch (error) {
            if (isBusyError(error)) {
                await handleBusyError(error);
                return;
            }
            state.currentOperation = '';
            showToast(error.message || '健康检查失败', 'error');
            setStatus(error.message || '健康检查失败', false);
        }
        return;
    }

    if (action === 'download-backup') {
        if (isBusy()) {
            showToast(`当前正在执行：${state.currentOperation}`, 'error');
            return;
        }

        setOperation('正在准备下载备份');
        let iframe = document.getElementById('archive-reserve-download-frame');
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.id = 'archive-reserve-download-frame';
            iframe.hidden = true;
            document.body.appendChild(iframe);
        }
        iframe.src = `${API_BASE}/backups/${releaseId}/download?ts=${Date.now()}`;
        syncOperationPolling();
        return;
    }

    if (action === 'full-restore') {
        if (isBusy()) {
            showToast(`当前正在执行：${state.currentOperation}`, 'error');
            return;
        }

        const confirmed = window.confirm('这会用备份完整覆盖本地整个 data 目录。确定继续吗？');
        if (!confirmed) {
            return;
        }

        setOperation('正在整包恢复');
        try {
            await apiRequest(`/backups/${releaseId}/restore`, {
                method: 'POST',
                body: { mode: 'full' },
            });
            setStatus('整包恢复完成，建议重启或刷新酒馆', false);
            showToast('整包恢复完成', 'success');
        } catch (error) {
            if (isBusyError(error)) {
                await handleBusyError(error);
                return;
            }

            state.currentOperation = '';
            showToast(error.message || '整包恢复失败', 'error');
            setStatus(error.message || '整包恢复失败', false);
        }
        return;
    }

    if (action === 'select-restore') {
        if (isBusy()) {
            showToast(`当前正在执行：${state.currentOperation}`, 'error');
            return;
        }

        await openRestoreModal(releaseId);
        return;
    }

    if (action === 'delete-backup') {
        if (isBusy()) {
            showToast(`当前正在执行：${state.currentOperation}`, 'error');
            return;
        }

        const confirmed = window.confirm('确定删除这个云端备份吗？');
        if (!confirmed) {
            return;
        }

        setOperation('正在删除备份');
        try {
            await apiRequest(`/backups/${releaseId}`, {
                method: 'DELETE',
            });
            state.backupsLoaded = false;
            if (state.activeTab === 'library') {
                await loadBackups();
            } else {
                renderBackupList();
            }
            invalidateSpaceStats();
            showToast('备份已删除', 'success');
        } catch (error) {
            if (isBusyError(error)) {
                await handleBusyError(error);
                return;
            }

            state.currentOperation = '';
            showToast(error.message || '删除备份失败', 'error');
            setStatus(error.message || '删除备份失败', false);
        }
    }
}

async function openRestoreModal(releaseId) {
    if (isBusy()) {
        showToast(`当前正在执行：${state.currentOperation}`, 'error');
        return;
    }

    setStatus('正在读取备份树', true);
    try {
        const result = await apiRequest(`/backups/${releaseId}/tree`);
        state.modal.releaseId = releaseId;
        state.modal.backup = result.backup;
        state.modal.meta = result.meta;
        state.modal.searchQuery = '';

        elements.modalTitle.textContent = `选择要恢复的路径：${result.backup.name}`;
        elements.treeSearchInput.value = '';
        elements.treeSearchMeta.textContent = '';
        elements.treeMeta.textContent = `${result.meta.stats.fileCount} 个文件，${result.meta.stats.directoryCount} 个文件夹，压缩包 ${formatBytes(result.meta.archive.totalBytes)}`;
        elements.restoreTree.innerHTML = renderTreeHtml(buildTree(result.meta.entries));
        collapseTreeDirectories();
        refreshDirectoryStates();
        elements.restoreModal.classList.remove('hidden');
        elements.restoreModal.setAttribute('aria-hidden', 'false');
        setStatus('已打开路径选择', false);
    } catch (error) {
        showToast(error.message || '读取备份树失败', 'error');
        setStatus(error.message || '读取备份树失败', false);
    }
}

function closeRestoreModal() {
    state.modal.releaseId = null;
    state.modal.backup = null;
    state.modal.meta = null;
    state.modal.searchQuery = '';
    elements.restoreTree.innerHTML = '';
    elements.treeMeta.textContent = '';
    elements.treeSearchInput.value = '';
    elements.treeSearchMeta.textContent = '';
    elements.restoreModal.classList.add('hidden');
    elements.restoreModal.setAttribute('aria-hidden', 'true');
}

function buildTree(entries) {
    const root = {
        path: '',
        name: 'data',
        type: 'dir',
        size: 0,
        children: new Map(),
    };

    for (const entry of entries) {
        const parts = entry.path.split('/');
        let cursor = root;
        for (let index = 0; index < parts.length; index += 1) {
            const name = parts[index];
            const nodePath = parts.slice(0, index + 1).join('/');
            if (!cursor.children.has(name)) {
                cursor.children.set(name, {
                    path: nodePath,
                    name,
                    type: 'dir',
                    size: 0,
                    children: new Map(),
                });
            }

            const next = cursor.children.get(name);
            if (index === parts.length - 1) {
                next.type = entry.type;
                next.size = entry.size || 0;
            }
            cursor = next;
        }
    }

    return root;
}

function compareTreeNodes(left, right) {
    if (left.type !== right.type) {
        return left.type === 'dir' ? -1 : 1;
    }
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
}

function renderTreeHtml(rootNode) {
    const children = Array.from(rootNode.children.values()).sort(compareTreeNodes);
    if (!children.length) {
        return '<div class="empty-state">这个备份里没有可恢复的路径。</div>';
    }
    return children.map((node) => renderTreeNode(node)).join('');
}

function renderTreeNode(node) {
    const escapedPath = escapeHtml(node.path);
    const escapedName = escapeHtml(node.name);
    const escapedTitle = escapeHtml(node.path);

    if (node.type === 'dir') {
        const children = Array.from(node.children.values()).sort(compareTreeNodes);
        return `
            <details class="tree-item tree-item-dir" data-path="${escapedPath}">
                <summary class="tree-summary">
                    <div class="tree-line">
                        <label class="tree-label" title="${escapedTitle}">
                            <input class="tree-check" type="checkbox" data-path="${escapedPath}" data-type="dir">
                            <span class="tree-name">${escapedName}/</span>
                        </label>
                    </div>
                </summary>
                <div class="tree-children">
                    ${children.map((child) => renderTreeNode(child)).join('')}
                </div>
            </details>
        `;
    }

    return `
        <div class="tree-item tree-item-file" data-path="${escapedPath}">
            <div class="tree-line">
                <label class="tree-label" title="${escapedTitle}">
                    <input class="tree-check" type="checkbox" data-path="${escapedPath}" data-type="file">
                    <span class="tree-name">${escapedName}</span>
                </label>
                <span class="tree-size">${escapeHtml(formatBytes(node.size))}</span>
            </div>
        </div>
    `;
}

function onTreeChange(event) {
    const checkbox = event.target.closest('.tree-check');
    if (!checkbox) {
        return;
    }

    if (checkbox.dataset.type === 'dir') {
        const scope = checkbox.closest('.tree-item-dir');
        if (scope) {
            scope.querySelectorAll('.tree-children .tree-check').forEach((child) => {
                child.checked = checkbox.checked;
                child.indeterminate = false;
            });
        }
    }

    refreshDirectoryStates();
}

function onTreeSearchInput(event) {
    applyTreeFilter(event.target.value);
}

function getOwnCheckbox(directoryElement) {
    return directoryElement.querySelector(':scope > summary .tree-check');
}

function getTreeChildren(directoryElement) {
    const container = directoryElement.querySelector(':scope > .tree-children');
    return container
        ? Array.from(container.children).filter((element) => element.classList.contains('tree-item'))
        : [];
}

function collapseTreeDirectories() {
    elements.restoreTree.querySelectorAll('.tree-item-dir').forEach((directory) => {
        directory.open = false;
    });
}

function normalizeSearchQuery(value) {
    return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function updateTreeSearchMeta(query, visibleCount) {
    if (!query) {
        elements.treeSearchMeta.textContent = '';
        return;
    }

    elements.treeSearchMeta.textContent = visibleCount > 0
        ? `搜索“${query}”后，当前显示 ${visibleCount} 条匹配路径。`
        : `没有找到和“${query}”相关的路径。`;
}

function applyTreeFilter(queryText) {
    const query = normalizeSearchQuery(queryText);
    state.modal.searchQuery = query;

    if (!query) {
        elements.restoreTree.querySelectorAll('.tree-item').forEach((node) => {
            node.classList.remove('is-hidden');
        });
        collapseTreeDirectories();
        updateTreeSearchMeta('', 0);
        return;
    }

    let visibleCount = 0;

    const visitNode = (node) => {
        const pathText = String(node.dataset.path || '').toLocaleLowerCase('zh-CN');
        const selfMatch = pathText.includes(query);

        if (node.classList.contains('tree-item-file')) {
            const visible = selfMatch;
            node.classList.toggle('is-hidden', !visible);
            if (visible) {
                visibleCount += 1;
            }
            return visible;
        }

        const children = getTreeChildren(node);
        let childVisible = false;
        for (const child of children) {
            childVisible = visitNode(child) || childVisible;
        }

        const visible = selfMatch || childVisible;
        node.classList.toggle('is-hidden', !visible);
        node.open = childVisible;
        if (visible && selfMatch) {
            visibleCount += 1;
        }
        return visible;
    };

    Array.from(elements.restoreTree.children)
        .filter((element) => element.classList.contains('tree-item'))
        .forEach((node) => {
            visitNode(node);
        });

    updateTreeSearchMeta(queryText.trim(), visibleCount);
}

function refreshDirectoryStates() {
    const directories = Array.from(elements.restoreTree.querySelectorAll('.tree-item-dir'))
        .sort((left, right) => right.dataset.path.length - left.dataset.path.length);

    for (const directory of directories) {
        const checkbox = getOwnCheckbox(directory);
        if (!checkbox) {
            continue;
        }

        const descendants = Array.from(directory.querySelectorAll('.tree-children .tree-check'));
        if (!descendants.length) {
            checkbox.indeterminate = false;
            continue;
        }

        const allChecked = descendants.every((item) => item.checked);
        const anyChecked = descendants.some((item) => item.checked || item.indeterminate);
        checkbox.checked = allChecked;
        checkbox.indeterminate = !allChecked && anyChecked;
    }
}

function selectAllTree(checked) {
    elements.restoreTree.querySelectorAll('.tree-check').forEach((checkbox) => {
        checkbox.checked = checked;
        checkbox.indeterminate = false;
    });
    refreshDirectoryStates();
}

function getSelectedRestoreMode() {
    const checked = document.querySelector('input[name="restoreMode"]:checked');
    return checked ? checked.value : 'merge';
}

function gatherSelectedPaths() {
    return Array.from(elements.restoreTree.querySelectorAll('.tree-check'))
        .filter((checkbox) => checkbox.checked && !checkbox.indeterminate)
        .map((checkbox) => checkbox.dataset.path);
}

async function onConfirmSelectiveRestore() {
    if (isBusy()) {
        showToast(`当前正在执行：${state.currentOperation}`, 'error');
        return;
    }

    const selectedPaths = gatherSelectedPaths();
    if (!selectedPaths.length || !state.modal.releaseId) {
        showToast('先勾选要恢复的路径', 'error');
        return;
    }

    const mode = getSelectedRestoreMode();
    const confirmed = window.confirm(mode === 'replace'
        ? '严格覆盖会先删除你选中的本地路径，再按备份内容重建。确定继续吗？'
        : '确定按当前选择执行恢复吗？');

    if (!confirmed) {
        return;
    }

    setOperation('正在按路径恢复');
    try {
        await apiRequest(`/backups/${state.modal.releaseId}/restore`, {
            method: 'POST',
            body: {
                mode,
                selectedPaths,
            },
        });
        closeRestoreModal();
        setStatus('按路径恢复完成，建议重启或刷新酒馆', false);
        showToast('按路径恢复完成', 'success');
    } catch (error) {
        if (isBusyError(error)) {
            await handleBusyError(error);
            return;
        }

        state.currentOperation = '';
        showToast(error.message || '按路径恢复失败', 'error');
        setStatus(error.message || '按路径恢复失败', false);
    }
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) {
        return `${value} B`;
    }

    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value || '未知时间';
    }
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
