# Archive Reserve / 档案保险库

[English](README_EN.md)

Archive Reserve 是一个给 SillyTavern 使用的完整数据备份 server plugin。

它会把当前用户数据打包成档案，存到 GitHub Releases，并提供：

- 整包备份
- 跨设备恢复
- 按路径恢复或覆盖
- 自动定时备份
- 档案健康检查
- 空间统计与手动回收

它的设计灵感来自现有的云备份类插件，
但当前实现使用的是不同的架构：基于 GitHub Releases 与隐藏分块存储。

官方仓库：

- `https://github.com/Asobi-123/archive-reserve`

克隆地址：

```bash
git clone https://github.com/Asobi-123/archive-reserve.git
```

## 功能简介

- 备份当前 SillyTavern 用户数据
- 使用 GitHub Releases 作为远端档案库
- 在同一个仓库里按设备查看档案
- 支持整包恢复
- 支持按文件夹或文件恢复
- 支持 `合并恢复` 和 `严格覆盖`
- 自动隐藏分块，减少后续重复上传
- 支持下载任意档案为完整 zip
- 支持自动备份与保留数量
- 支持健康检查与孤儿分块回收

## 备份范围

默认优先备份：

```text
data/default-user
```

如果当前环境没有这个目录，则回退到：

```text
data
```

会自动忽略这些内容：

- `.git`
- `.gitkeep`
- `.DS_Store`
- `Thumbs.db`
- `.archive-reserve`

## 安装

Archive Reserve 是一个 **SillyTavern server plugin**。

### 安装前先确认

你需要先找到自己的 **SillyTavern 根目录**。

通常这个目录里会有这些东西：

```text
config.yaml
package.json
plugins/
public/
data/
```

另外还需要：

- `Node.js` 和 `npm`
- 能访问 GitHub

### 方法一：用 git clone 安装

这是最适合后续更新的方式。

1. 打开终端。
2. 进入你的 SillyTavern 根目录。
3. 再进入 `plugins` 目录。
4. 执行：

```bash
git clone https://github.com/Asobi-123/archive-reserve.git
```

5. 进入插件目录：

```bash
cd archive-reserve
```

6. 安装依赖：

```bash
npm install
```

装好以后，你的目录应该是这样：

```text
SillyTavern/
  plugins/
    archive-reserve/
      index.js
      package.json
      public/
```

### 方法二：下载 ZIP 安装

如果你不想用 git，也可以直接下载压缩包。

1. 打开仓库页面：

```text
https://github.com/Asobi-123/archive-reserve
```

2. 点击绿色 `Code` 按钮。
3. 点击 `Download ZIP`。
4. 把下载下来的压缩包解压。
5. 解压后你大概率会得到一个类似这样的文件夹：

```text
archive-reserve-main
```

6. 把这个文件夹改名成：

```text
archive-reserve
```

7. 把它移动到：

```text
SillyTavern/plugins/
```

8. 最终目录必须是：

```text
SillyTavern/plugins/archive-reserve/
```

不要变成这样：

```text
SillyTavern/plugins/archive-reserve-main/
SillyTavern/plugins/archive-reserve/archive-reserve/
```

9. 打开终端，进入：

```bash
cd SillyTavern/plugins/archive-reserve
```

10. 执行：

```bash
npm install
```

### 打开 server plugin

安装完后，打开 SillyTavern 根目录的 `config.yaml`，确认这两项存在：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

如果原本是 `false`，改成上面这样。

### 最后一步

重启 SillyTavern。

重启后再打开插件页面：

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

### 安装是否成功，怎么判断

看到页面能打开，就说明前端入口已经正常。

如果还不放心，再检查一次目录：

```text
SillyTavern/plugins/archive-reserve/index.js
SillyTavern/plugins/archive-reserve/package.json
SillyTavern/plugins/archive-reserve/public/index.html
```

如果这些文件都在，`npm install` 也执行过，而且 `config.yaml` 已经打开 server plugin，通常就没问题。

## 插件入口

默认地址：

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

如果你的 SillyTavern 不在 `8000` 端口，请把端口号替换成你自己的。

## GitHub 仓库准备

Archive Reserve 需要一个 GitHub 仓库来存放档案。
推荐使用 **Private 私有仓库**。

建立步骤：

1. 打开 GitHub。
2. 右上角点击 `+`。
3. 选择 `New repository`。
4. 仓库名填：

```text
archive-reserve
```

5. 可见性选 `Private`。
6. 推荐勾选 `Add a README file`，让仓库从一开始就不是空仓库。
7. 点 `Create repository`。

插件里支持两种仓库写法：

- `Asobi-123/archive-reserve`
- `https://github.com/Asobi-123/archive-reserve.git`

GitHub 官方建仓说明：

- https://docs.github.com/articles/creating-a-new-repository

## GitHub Token 准备

Archive Reserve 需要一个 GitHub Personal Access Token。

### 最省事的做法

直接使用 **Personal access token (classic)**。

创建步骤：

1. 打开 GitHub。
2. 进入 `Settings`。
3. 左侧进入 `Developer settings`。
4. 打开 `Personal access tokens`。
5. 选择 `Tokens (classic)`。
6. 点 `Generate new token (classic)`。
7. 给 token 起一个名字，例如：

```text
Archive Reserve
```

8. 过期时间按你自己需求设置。
9. 权限勾选：

```text
repo
```

10. 生成后立刻复制保存。

对这个插件来说，classic token 选 `repo` 就够用。

### 更细权限的做法

如果你更想限制权限，可以使用 **Fine-grained personal access token**。

建议这样配：

1. `Repository access` 选择：

```text
Only select repositories
```

2. 只勾选你的目标仓库：

```text
Asobi-123/archive-reserve
```

3. `Repository permissions` 里至少给：

```text
Contents: Read and write
```

如果 GitHub 页面还显示 `Metadata`，保持读取权限即可。

### 额外注意

- 如果仓库属于组织，组织可能会限制 token 使用。
- 如果组织启用了 SSO，token 可能还需要额外授权。
- Token 生成后只会完整显示一次，丢了就要重新生成。

GitHub 官方 token 说明：

- https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token

## 第一次使用

1. 打开插件页面：

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

2. 在 `仓库设置` 里填写：
   - GitHub 仓库
   - GitHub Token
   - 当前设备名
3. 点击 `保存设置`。
4. 切到 `创建备份`。
5. 点击 `创建整包备份`。

第一次上传通常最慢。
后续备份如果很多内容没有变化，会复用已有隐藏分块。

## 日常使用

### 创建备份

打开页面后，切到 `创建备份`，点击：

```text
创建整包备份
```

可以不填备份名，让插件自动生成。
也可以写备注，方便以后区分。

### 整包恢复

1. 打开 `档案库`
2. 找到目标档案
3. 点击整包恢复

这会用该档案完整恢复当前备份目录。

### 按路径恢复

1. 打开 `档案库`
2. 找到目标档案
3. 点击按路径恢复
4. 勾选想恢复的文件夹或文件
5. 选择模式：
   - `合并恢复`
   - `严格覆盖`
6. 确认恢复

`合并恢复` 适合把缺的东西补回来。  
`严格覆盖` 适合让选中的路径完全以档案内容为准。

### 跨设备恢复

1. 设备 A 上传备份
2. 设备 B 配置到同一个 GitHub 仓库
3. 设备 B 打开 `档案库`
4. 选择设备 A 的档案并恢复

### 下载备份

在 `档案库` 里点击 `下载`。
插件会把隐藏分块重组后导出成完整 zip。

### 自动备份

在 `仓库设置` 里可以开启自动备份，并设置：

- 备份间隔
- 自动档案保留数量
- 手动档案保留数量

## 维护功能

`维护` 页面提供：

- `刷新空间`：查看当前仓库占用
- `立即回收`：清理不再被任何档案引用的旧分块
- `检查`：检查某个档案是否完整可恢复

## 常见问题

**Q：配置保存在什么地方？**

```text
data/.archive-reserve/config.json
```

**Q：如果仓库是空仓库怎么办？**

插件会尝试自动初始化。
为了更稳，建仓库时直接勾选 README 就行。

**Q：超过 2 GiB 会怎样？**

插件会自动使用隐藏分卷。
对界面来说仍然是一份档案。

**Q：这个插件会不会改动我正常使用中的酒馆目录结构？**

插件会读取当前备份目录并在需要时写回恢复结果。
运行时配置保存在 `data/.archive-reserve/`。

## 相关文档

- **更新日志** — [CHANGELOG.md](CHANGELOG.md)
- **架构说明** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **数据模型** — [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- **手动测试清单** — [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md)
- **常见问题排查** — [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## 许可证

[AGPL-3.0](LICENSE)
