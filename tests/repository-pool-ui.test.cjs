'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('pool UI exposes member admission and explicit backup placement', () => {
    assert.match(html, /id="pool-member-repo-input"/);
    assert.match(html, /id="pool-member-token-input"/);
    assert.doesNotMatch(html, /id="token-input"/);
    assert.match(html, /class="config-basics"/);
    assert.match(html, /id="backup-repository-input"/);
    assert.match(app, /apiRequest\('\/pool\/members'/);
    assert.match(app, /configPayload\(\{ repo, token \}\)/);
    assert.match(app, /repositoryId: elements\.backupRepositoryInput\.value/);
    assert.match(app, /normalizeRepositoryInput/);
    assert.doesNotMatch(app, /成员仓库<\/span>/);
    assert.doesNotMatch(app, /token 已配置/);
});

test('backup actions retain repository identity and partial state', () => {
    assert.match(app, /data-repository-id=/);
    assert.match(app, /body: \{ repositoryId \}/);
    assert.match(app, /new URLSearchParams\(\{ repositoryId/);
    assert.match(app, /部分仓库当前不可用/);
    assert.match(app, /backup\.source\?\.repo/);
});

test('segment switch requires the expected active segment', () => {
    assert.match(html, /id="active-pool-repository-input"/);
    assert.match(app, /expectedSegmentId: select\.dataset\.segmentId/);
    assert.match(app, /切换只影响之后创建的完整备份/);
});
