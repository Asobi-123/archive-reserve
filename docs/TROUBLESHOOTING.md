# Troubleshooting

This guide covers the most common setup and runtime issues for Archive Reserve.

## The UI Page Does Not Open

Check these points:

- `plugins/archive-reserve/index.js` exists under the target SillyTavern root
- `config.yaml` has `enableServerPlugins: true`
- SillyTavern has been restarted after installation
- the startup log shows Archive Reserve being initialized

The UI entry is:

```text
/api/plugins/archive-reserve/ui
```

This plugin is a server plugin page, not a normal extension drawer entry.

Also note:

- newer builds no longer auto-run deep maintenance space statistics on first page load
- if a low-memory environment still struggles, avoid opening `维护` and immediately pressing `刷新空间` before confirming the page itself is stable

## "ForbiddenError: Invalid CSRF token"

Refresh the page, then try again.

This usually means the page was left open across a restart or the CSRF token changed after a reload.

## "Git Repository is empty"

Archive Reserve tries to initialize an empty repository automatically.

If GitHub still rejects it:

1. create one initial commit in that repository, such as a README
2. return to the plugin page
3. save settings again and retry

## Backup Or Restore Says Another Operation Is Running

Example:

```text
当前正在执行：正在创建备份
```

Archive Reserve allows only one heavy operation at a time.

Wait for the current job to finish, then retry.
This applies to:

- backup
- restore
- download
- health check
- manual GC

## GitHub Timeout, HTTP, Or Socket Errors

Common examples:

- `UND_ERR_CONNECT_TIMEOUT`
- `UND_ERR_HEADERS_TIMEOUT`
- `UND_ERR_SOCKET`
- HTTP `408`, `429`, `500`, `502`, `503`, or `504`

What to check:

- current network can reach `api.github.com`
- GitHub is not being blocked by the current environment
- the repository and token are valid

Archive Reserve retries lightweight read-only GitHub requests, including transient HTTP failures. Uploads and other writes are not automatically redirected to another repository, so unstable networks can still fail large or repeated operations.

## The Backup Library Is Empty Or Missing One Repository

Check these points:

- each expected repository is still listed in repository settings
- `data/.archive-reserve/config.json` exists
- the catalog repository is reachable
- the saved default token or that member's own token still has access to the repository

The archive library combines backups from every readable pool member. If one member is temporarily unavailable, backups from other members remain visible and the page reports a partial result. It does not mean that the unavailable repository is empty or that its backups were deleted.

After repository access returns, refresh the archive library. The member's backups should reappear without changing the current write repository.

## A Repository Needs A Different Token

The first repository token is reused by default. A member can instead store its own local token:

1. open repository settings
2. use the credential action for the affected repository
3. enter a token that can access that repository
4. save and retry the failed read or write

Changing one member's token does not change other members. Tokens stay in the local server config and are not written to the remote pool descriptor.

## Switching The Write Repository Fails

A switch can update the authoritative pool mapping before the target repository's descriptor mirror is ready. When this happens, Archive Reserve reports that the target is not ready instead of pretending the old repository is still selected.

Confirm that the target repository and its token are writable, then retry the switch. Do not create a second pool or re-add repositories to work around the error.

## Backup Feels Slow

Things to know:

- the first backup is usually the slowest
- later backups can reuse unchanged hidden chunks
- very large `user/images/*` or `user/files/*` trees still take time if they changed heavily

If every backup is always as slow as the first one, check whether the same repository is being reused and whether the old hidden chunk-store release still exists.

The first backup after switching to a repository that has never stored this backup lane must establish reusable chunks there. Switching back to a repository used earlier reuses that repository's existing chunks; it does not initialize a new chunk store or reuse chunks from another repository.

## Restore Feels Slow

Selective restore is faster than full restore only when the selected paths map to fewer hidden chunks.

If you restore very broad paths such as a whole hotspot directory, the plugin may still need to download many chunks.

## Restore Or Download Gets Stuck While Extracting Chunks

Starting from `v0.1.6`, Archive Reserve treats a stalled zip entry extraction as an explicit error instead of leaving the operation lock active indefinitely.

If restore or download fails with an extraction timeout:

- run health check for that backup
- retry once after confirming the current network and disk are stable
- collect the backup name, chunk detail, visible error text, and server log before reporting the issue

## Download Fails Or Produces Missing Files

Check these points:

- the target backup passes health check
- the hidden chunk-store release still exists
- the repository was not manually edited to remove chunk assets

If health check reports missing chunk assets, that backup is incomplete and must be recreated from a healthy device.

## Extension Update Detection Stops Working After Restore

Check these points:

- whether the affected extension lives under the selected backup root, such as `data/default-user/extensions/<name>`
- whether that extension was originally installed as a Git repository
- whether the backup was created with Archive Reserve `v0.1.2` or later

Starting from `v0.1.2`, Archive Reserve preserves `extensions/<name>/.git` metadata in backup, download, and restore flows.

If the extension was restored from an older backup that did not include its Git metadata, reinstall that extension once so its `.git` directory is recreated.

## Auto Backup Does Not Run

Check these points:

- auto backup is enabled in settings
- repository and token are saved
- SillyTavern is still running
- another long-running job is not blocking the schedule every time

Also note:

- auto backup is not a background cloud service
- if SillyTavern is offline, nothing runs

## Before Reporting A Bug

Collect these details:

- Archive Reserve version
- SillyTavern version
- install style: local / Docker / other
- current backup root, such as `data/default-user`
- exact UI action
- visible UI error text
- server log error text
