'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

test('pool UI exposes member admission and explicit backup placement', () => {
    assert.match(html, /id="pool-member-repo-input"/);
    assert.match(html, /id="pool-member-token-input"/);
    assert.doesNotMatch(html, /id="token-input"/);
    assert.match(html, /class="config-basics"/);
    assert.match(html, /id="pool-guide-toggle"[^>]+aria-expanded="false"/);
    assert.match(html, /id="pool-guide" class="pool-guide hidden"/);
    assert.match(html, /多台设备可以使用同一仓库/);
    assert.match(html, /不会在仓库之间自动均衡/);
    assert.match(html, /切回使用过的仓库会继续复用其中已有分块/);
    assert.match(html, /id="backup-repository-input"/);
    assert.match(app, /apiRequest\('\/pool\/members'/);
    assert.match(app, /configPayload\(\{ repo, token \}\)/);
    assert.match(app, /\/credentials`/);
    assert.match(server, /router\.patch\('\/pool\/members\/:repositoryId\/credentials'/);
    assert.match(server, /updateRuntimeMemberCredential\(candidate, repositoryId, token\)/);
    assert.match(app, /repositoryId: elements\.backupRepositoryInput\.value/);
    assert.match(server, /repositoryId: trimToEmpty\(req\.body\?\.repositoryId\)/);
    assert.match(server, /syncDescriptorMirror\(memberContext, descriptor\)/);
    assert.match(app, /normalizeRepositoryInput/);
    assert.match(app, /data-action="delete-pool-member"/);
    assert.match(app, /body: \{ localOnly: true \}/);
    assert.match(server, /async function removeLocalPoolMember/);
    assert.match(server, /remoteChanged: false/);
    assert.match(server, /descriptorForConfiguredMembers\(config, snapshot\.descriptor\)/);
    assert.match(server, /repositoryPool\.validateMemberMarker\(marker\.value/);
    assert.match(server, /adopted: true/);
    assert.doesNotMatch(app, /成员仓库<\/span>/);
    assert.match(app, />主仓库<\/span>/);
    assert.doesNotMatch(app, /token 已配置/);
    assert.doesNotMatch(`${html}\n${app}`, /旧版|旧备份|已有序列|原仓库/);
});

test('backup actions retain repository identity and partial state', () => {
    assert.match(app, /data-repository-id=/);
    assert.match(app, /body: \{ repositoryId \}/);
    assert.match(app, /new URLSearchParams\(\{ repositoryId/);
    assert.match(app, /部分仓库当前不可用/);
    assert.match(app, /elements\.backupList\.innerHTML = poolNotice \|\|/);
    assert.match(app, /backup\.source\?\.repo/);
    assert.match(server, /isRetryableGitHubStatus\(response\.status\)/);
    assert.match(server, /\(method === 'GET' \|\| method === 'HEAD'\) \? 5 : 1/);
    assert.match(server, /action: '读取仓库 release 索引',[\s\S]*retryAttempts: 5/);
});

test('maintenance space stats break usage down by repository and device', () => {
    assert.match(server, /repositories,/);
    assert.match(server, /devices,/);
    assert.match(server, /logicalBytes/);
    assert.match(app, />按仓库</);
    assert.match(app, />按设备</);
    assert.match(app, /实际占用/);
    assert.match(app, /档案数据量/);
});

test('segment switch requires the expected active segment', () => {
    assert.match(html, /id="active-pool-repository-input"/);
    assert.match(app, /expectedSegmentId: select\.dataset\.segmentId/);
    assert.match(app, /之后创建的备份将写入所选仓库/);
    assert.match(server, /ready: Boolean\(targetMirror\?\.synced\)/);
    assert.match(app, /result\?\.ready === false/);
});

test('member activation and segment switches only synchronize locally configured members', () => {
    assert.match(server, /descriptorForConfiguredMembers\(config, activated\.descriptor\)\.members/);
    assert.match(server, /descriptorForConfiguredMembers\(config, updated\.descriptor\)\.members/);
    assert.doesNotMatch(server, /const contexts = activated\.descriptor\.members/);
    assert.doesNotMatch(server, /const contexts = updated\.descriptor\.members/);
});

test('create backup view reflects the current lane repository', () => {
    assert.match(html, /id="backup-repository-label"/);
    assert.match(html, /id="backup-repository-hint"/);
    assert.match(app, /const activeSegment = findCurrentLaneEntry\(\)/);
    assert.match(app, /const displayedMembers = activeSegment \? \(activeMember \? \[activeMember\] : \[\]\) : writableMembers/);
    assert.match(app, /textContent = activeSegment \? '当前写入仓库' : '首次写入仓库'/);
    assert.match(app, /dataset\.fixed = String\(Boolean\(activeSegment\)\)/);
    assert.match(server, /currentLaneId: currentLane\.laneId/);
    assert.match(app, /state\.pool\?\.currentLaneId/);
});
