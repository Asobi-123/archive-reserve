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

## GitHub Timeout Or Socket Errors

Common examples:

- `UND_ERR_CONNECT_TIMEOUT`
- `UND_ERR_HEADERS_TIMEOUT`
- `UND_ERR_SOCKET`

What to check:

- current network can reach `api.github.com`
- GitHub is not being blocked by the current environment
- the repository and token are valid

Archive Reserve already retries lightweight read requests, but unstable networks can still fail large or repeated operations.

## The Backup Library Is Empty After Restart

Check these points:

- repository and token were actually saved
- `data/.archive-reserve/config.json` exists
- the saved repository is the same one that contains your backup releases
- GitHub token still has access to that repository

## Backup Feels Slow

Things to know:

- the first backup is usually the slowest
- later backups can reuse unchanged hidden chunks
- very large `user/images/*` or `user/files/*` trees still take time if they changed heavily

If every backup is always as slow as the first one, check whether the same repository is being reused and whether the old hidden chunk-store release still exists.

## Restore Feels Slow

Selective restore is faster than full restore only when the selected paths map to fewer hidden chunks.

If you restore very broad paths such as a whole hotspot directory, the plugin may still need to download many chunks.

## Download Fails Or Produces Missing Files

Check these points:

- the target backup passes health check
- the hidden chunk-store release still exists
- the repository was not manually edited to remove chunk assets

If health check reports missing chunk assets, that backup is incomplete and must be recreated from a healthy device.

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
- current backup root: `data/default-user` or `data`
- exact UI action
- visible UI error text
- server log error text
