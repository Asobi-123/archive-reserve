# Archive Reserve / Archive Vault

[中文](README.md)

Archive Reserve is a SillyTavern server plugin for full-user-data backup and restore.

It stores backups in GitHub Releases and provides:

- full backup
- cross-device restore
- selective path restore or overwrite
- scheduled auto backup
- backup health check
- space stats and manual cleanup

It is inspired by existing cloud backup plugins,
but implemented using a different architecture based on GitHub Releases and hidden chunk storage.

Repository:

- `https://github.com/Asobi-123/archive-reserve`

Clone:

```bash
git clone https://github.com/Asobi-123/archive-reserve.git
```

## Features

- backs up the active SillyTavern user data directory
- uses GitHub Releases as the remote archive library
- combines multiple GitHub repositories into one archive library and lists all backups by device
- lets multiple devices share the same repository pool
- supports full restore
- supports selective restore by folder or file
- supports `merge` and `replace` restore modes
- uses hidden chunks to reduce later re-upload cost
- supports backup download as a reconstructed full zip
- supports scheduled auto backup and retention
- supports health check and orphan chunk cleanup

## Backup Scope

Archive Reserve prefers:

```text
data/default-user
```

If that directory does not exist, it falls back to:

```text
data
```

You can switch to another user directory under `data` in the repository settings. Backup creation, full restore, selective restore, scheduled backup, and retention use the currently selected user directory.

Ignored content:

- `.git`
- `.gitkeep`
- `.DS_Store`
- `Thumbs.db`
- `.archive-reserve`

## Installation

Archive Reserve is a **SillyTavern server plugin**.

### Before You Start

Find your **SillyTavern root directory** first.

It usually contains:

```text
config.yaml
package.json
plugins/
public/
data/
```

You also need:

- `Node.js` and `npm`
- GitHub access

### Option 1: Install with git clone

This is the better option if you want to update later.

1. Open a terminal.
2. Go to your SillyTavern root.
3. Enter the `plugins` directory.
4. Run:

```bash
git clone https://github.com/Asobi-123/archive-reserve.git
```

5. Enter the plugin directory:

```bash
cd archive-reserve
```

6. Install dependencies:

```bash
npm install
```

After that, your layout should look like:

```text
SillyTavern/
  plugins/
    archive-reserve/
      index.js
      package.json
      public/
```

### Option 2: Install from ZIP

If you do not want to use git, download the ZIP package instead.

1. Open:

```text
https://github.com/Asobi-123/archive-reserve
```

2. Click the green `Code` button.
3. Click `Download ZIP`.
4. Extract the ZIP.
5. You will probably get a folder like:

```text
archive-reserve-main
```

6. Rename that folder to:

```text
archive-reserve
```

7. Move it into:

```text
SillyTavern/plugins/
```

8. The final path must be:

```text
SillyTavern/plugins/archive-reserve/
```

Do not leave it like:

```text
SillyTavern/plugins/archive-reserve-main/
SillyTavern/plugins/archive-reserve/archive-reserve/
```

9. Open a terminal and enter:

```bash
cd SillyTavern/plugins/archive-reserve
```

10. Run:

```bash
npm install
```

### Enable Server Plugins

Open `config.yaml` in your SillyTavern root and make sure it contains:

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

If it was `false`, change it to the values above.

### Final Step

Restart SillyTavern.

Then open:

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

### How To Verify The Install

If the page opens, the UI entry is available.

You can also check that these files exist:

```text
SillyTavern/plugins/archive-reserve/index.js
SillyTavern/plugins/archive-reserve/package.json
SillyTavern/plugins/archive-reserve/public/index.html
```

If those files are present, `npm install` completed, and `config.yaml` enables server plugins, the install is usually correct.

## Updating The Plugin

If you already installed `Archive Reserve` and want to update it, use the same method you originally used to install it.

### If you originally installed with git clone

1. Go to:

```text
SillyTavern/plugins/archive-reserve
```

2. Open a terminal in that folder.
3. Run:

```bash
git pull
npm install
```

4. Restart SillyTavern.

### If you originally installed from ZIP

1. Download the latest ZIP from GitHub.
2. Extract it.
3. Replace the old folder at:

```text
SillyTavern/plugins/archive-reserve
```

4. Open a terminal in that folder.
5. Run again:

```bash
npm install
```

6. Restart SillyTavern.

### How To Confirm The Update

Open:

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

If the page opens normally, the update is usually in place.

## UI Entry

Default URL:

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

If your SillyTavern uses another port, replace `8000` with your own port.

## GitHub Repository Setup

Archive Reserve needs a GitHub repository for remote storage.
A private repository is recommended.

Basic setup:

1. Open GitHub.
2. Click `+`.
3. Choose `New repository`.
4. Name it:

```text
archive-reserve
```

5. Choose `Private`.
6. Prefer enabling `Add a README file` so the repository is not empty.
7. Click `Create repository`.

Accepted repository input:

- `Asobi-123/archive-reserve`
- `https://github.com/Asobi-123/archive-reserve.git`

Official GitHub documentation:

- https://docs.github.com/articles/creating-a-new-repository

## GitHub Token Setup

Archive Reserve needs a GitHub Personal Access Token.

### Easiest option

Use a **Personal access token (classic)**.

Steps:

1. Open GitHub `Settings`.
2. Go to `Developer settings`.
3. Open `Personal access tokens`.
4. Choose `Tokens (classic)`.
5. Click `Generate new token (classic)`.
6. Give it a name such as `Archive Reserve`.
7. Choose an expiration time.
8. Select this scope:

```text
repo
```

9. Generate the token and copy it immediately.

For this plugin, a classic token with `repo` is enough.

### Fine-grained option

If you prefer narrower permissions, use a **Fine-grained personal access token**.

Recommended setup:

1. Set `Repository access` to:

```text
Only select repositories
```

2. Select:

```text
Asobi-123/archive-reserve
```

3. Under `Repository permissions`, grant at least:

```text
Contents: Read and write
```

If GitHub also shows `Metadata`, keep read access enabled.

### Notes

- Organization policies may restrict token access.
- If the repository uses SSO, the token may require extra authorization.
- GitHub only shows the full token once after creation.

Official GitHub documentation:

- https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token

## First Use

1. Open:

```text
http://127.0.0.1:8000/api/plugins/archive-reserve/ui
```

2. In `仓库设置`, click `添加仓库`.
3. Paste a full GitHub repository URL or enter `owner/repo`, then provide a token that can access it.
4. Set the device name and backup user directory, then save settings.
5. Go to `创建备份`, confirm the first write repository, and create the full backup.

A repository uploads more data the first time it stores a backup because it must establish its own hidden chunks.
Switching back to a repository used before continues reusing its existing chunks.

### Add and switch repositories

- Use `添加仓库` in `仓库设置` to expand the pool.
- A new member can reuse the first repository token. Enter a separate token only when its permissions differ.
- Existing pool members must also be added manually, one at a time. Entering one old repository never imports the remote pool's other members.
- The pool does not load-balance automatically. One backup always remains complete inside one repository.
- The delete action on a repository row removes only this device's local configuration; it never deletes the GitHub repository or remote backups.
- `当前写入仓库` controls where this device creates later backups. Switching does not move historical archives.
- The library, restore, download, health check, and maintenance views read every available pool member.

## Daily Usage

### Create backup

Open `创建备份` and start a full backup.

### Full restore

Open `档案库`, choose a backup, then run full restore.

### Selective restore

Open `档案库`, choose a backup, open path restore, tick the folders or files you want, then choose:

- `合并恢复`
- `严格覆盖`

### Cross-device restore

1. Device A uploads a backup.
2. Device B manually adds one existing repository and provides a token that can access it.
3. After Archive Reserve recognizes that repository's pool, Device B opens `档案库`.
4. Device B manually adds other pool members one at a time when it needs access to them; Archive Reserve never imports them automatically.

The same repository can be used by multiple Archive Reserve devices.

### Download backup

Use the `下载` action in the archive library.
Archive Reserve reconstructs a full zip before download.

### Automatic backup

In `仓库设置`, you can enable automatic backup and configure:

- interval
- automatic backup retention
- manual backup retention

## Maintenance

The `维护` page includes:

- `刷新空间`, with physical usage per repository and logical archive data per device
- `立即回收`
- per-backup `检查`

Device data is the sum of the original data recorded by its backups. Because backups can reuse chunks, this is not additional GitHub storage usage; use the repository breakdown for physical usage.

## FAQ

**Where is plugin config stored?**

```text
data/.archive-reserve/config.json
```

**What if the repository is empty?**

The plugin will try to initialize it automatically.
Creating the repository with a README is still recommended.

**What happens above 2 GiB?**

The plugin switches to hidden split parts automatically.
The UI still treats it as one archive.

## Related Docs

- **Changelog** — [CHANGELOG.md](CHANGELOG.md)
- **Architecture** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Data Model** — [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- **Manual Testing Checklist** — [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md)
- **Troubleshooting** — [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## License

[AGPL-3.0](LICENSE)
