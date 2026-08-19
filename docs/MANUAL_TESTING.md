# Manual Testing Checklist

This checklist is for release validation before publishing a new Archive Reserve version.

## Preconditions

- SillyTavern starts without server-plugin load errors.
- `plugins/archive-reserve` exists in the target SillyTavern root.
- `config.yaml` has `enableServerPlugins: true`.
- Two GitHub test repositories and usable tokens are ready.
- Test at least one desktop viewport and one mobile/narrow viewport.

## 1. First Repository And Config Reload

Steps:

1. Open `/api/plugins/archive-reserve/ui`.
2. Click `添加仓库`, paste a full GitHub repository URL, enter its token, and confirm.
3. Confirm that this first usable repository becomes the current write repository.
4. Set the device name, backup user directory, and auto-backup options.
5. Save settings and restart SillyTavern.
6. Open the page again.

Expected:

- The repository remains in the repository list and is still the current write repository.
- The saved token is not shown in full.
- Device name persists.
- Backup user directory persists.
- Auto-backup settings persist.

## 2. Backup User Directory Selection

Steps:

1. Prepare a second top-level user directory under `data`.
2. Open `仓库设置`.
3. Select that user directory and save settings.
4. Create a manual backup.
5. Restore from that backup while the same user directory is selected.
6. Switch back to another user directory and try to restore the backup again.

Expected:

- The backup root hint shows the selected user directory.
- The archive card shows the selected directory as its source.
- Backup scanning reads only the selected user directory.
- Full restore writes only to the selected user directory.
- Restore is blocked when the backup source directory and the current selected directory do not match.

## 3. Empty Repository Bootstrap

Steps:

1. Point Archive Reserve at a brand-new empty private repository.
2. Save settings.
3. Create the first backup.

Expected:

- The plugin initializes the repository if GitHub allows it.
- If GitHub refuses, the error is clear enough to tell the user to add an initial commit.

## 4. First Manual Backup

Steps:

1. Create a manual backup with a custom note.
2. Wait for completion.
3. Refresh the archive library.

Expected:

- One new archive appears.
- Device name, created time, size, and note are correct.
- The status panel returns to idle after completion.

## 5. Later Backup Reuse

Steps:

1. Make a limited change inside a hotspot directory such as `user/images/<project>` or `user/files/<subdir>`.
2. Create another backup.

Expected:

- The second backup succeeds.
- It should not behave like a full first-time upload again.
- The backup metadata still reconstructs into a complete archive.

## 5A. Repository Pool And Cross-Device Use

Steps:

1. Add a second repository by pasting its full GitHub URL and leave its token empty to reuse the saved default token.
2. When the repositories require different credentials, update only the second repository with its own token and retry.
3. Switch the current backup root's write repository to the second member.
4. Confirm that both `仓库设置` and `创建备份` show the second member as the current write repository.
5. Create a backup, switch back to the first repository, and create another backup with mostly unchanged data.
6. Refresh `档案库` and confirm that backups from both repositories are present.
7. Clear the second device's local Archive Reserve config. Add one existing pool repository manually, then open its archive library. Do not add the other pool repositories.

Expected:

- Adding a member does not move or copy existing backups.
- The selected write repository is consistent across settings and backup creation.
- Each completed backup and all of its chunks remain in one source repository.
- Returning to a previously used repository reuses its existing chunks instead of initializing a new store.
- The second device adopts only the manually entered member and sees backups readable through that member.
- The second device does not display or scan other remote pool members until each one is manually added.
- A member with its own token uses that local override without exposing the token in UI responses or remote pool files.

## 5C. Existing Pool Adoption And Local Member Deletion

Steps:

1. Start from an empty local Archive Reserve configuration.
2. Add a brand-new empty repository and confirm it works.
3. Add one repository that already contains an Archive Reserve marker and pool descriptor.
4. Confirm that only the manually entered existing repository is adopted; no other remote pool member appears.
5. Delete one repository row with its `x` action.
6. Refresh the page and inspect the remote pool from another device.

Expected:

- A valid existing repository is adopted without the "请改用空仓库" error.
- No remote descriptor, marker, mirror, release, or backup is written during adoption.
- Deleting a row removes only that repository from this device's local configuration.
- The deleted repository and its backups remain unchanged on GitHub and can be manually added again later.

## 5B. Partial Repository Read

Steps:

1. Temporarily remove access to one non-catalog member or simulate transient GitHub `408`, `429`, or `5xx` responses.
2. Refresh the archive library.
3. Restore access and refresh again.

Expected:

- Read-only requests retry transient failures before reporting the member unavailable.
- Backups from readable members remain visible.
- The failed member is shown as partial/unavailable rather than as an empty repository.
- After access returns, its backups reappear without changing the current write repository.

## 6. Full Restore

Steps:

1. Prepare a local change that is easy to verify.
2. Pick an older backup.
3. Run full restore.

Expected:

- The selected backup fully replaces the active backup root.
- The changed local content is reverted to the backup state.

## 7. Selective Restore

Steps:

1. Open path restore for a backup.
2. Use search in the restore tree.
3. Select one folder or a few files only.
4. Test `merge`.
5. Test `replace`.

Expected:

- The tree loads correctly and can be searched.
- `merge` overwrites selected files but keeps other local content.
- `replace` clears selected roots first, then rebuilds them from the backup.
- Restore progress updates while chunks are being processed.

## 7A. Restore Staging Failure Safety

Steps:

1. Put a local marker file in the active backup root.
2. Start a full, merge, and replace restore while using a test backup whose required chunk asset has been removed or made unreadable.
3. Repeat with a backup from the second member of a two-repository pool.

Expected:

- The restore fails before the local target is cleared or overwritten.
- The local marker and all selected target paths remain unchanged.
- Temporary staging files are removed after the failure.
- The request reads the release, metadata, and chunks only from the selected `repositoryId`.

## 8. Download Export

Steps:

1. Choose an archive.
2. Click download.
3. Inspect the exported zip.

Expected:

- Download completes without `ENOENT` or missing-file errors.
- The zip contains a complete reconstructable data tree for that backup.

## 9. Health Check

Steps:

1. Run `检查` on a valid archive.

Expected:

- The plugin reports a healthy result.
- File, chunk, and part counts are shown.
- If a chunk is missing in the repository, the error should list it explicitly.

## 10. Space Stats And Manual GC

Steps:

1. Open `维护`.
2. Refresh space stats.
3. Run manual garbage collection.

Expected:

- Space stats render correctly.
- Physical usage is broken down by repository.
- Logical archive data and backup counts are broken down by device.
- Refresh gives visible feedback.
- GC returns a result even when nothing is reclaimable.
- Reclaimable space decreases after orphan chunks are deleted.
- If any pool member or metadata asset is unavailable, the scan is marked incomplete and no chunk is deleted.
- A new orphan remains protected after the first complete scan and becomes eligible only after a second complete scan at least six hours later.
- Deleting a backup does not immediately run GC or touch another member's same-named assets.
- An incomplete or stale scan disables GC instead of advancing orphan evidence.

## 11. Auto Backup

Steps:

1. Enable auto backup.
2. Choose an hourly interval.
3. Set an automatic retention count.
4. Wait for one scheduled run.

Expected:

- Auto-backup state survives restart.
- One scheduled backup is created.
- Retention deletes older automatic archives from the same device and backup user directory when over limit.

## 12. Search, Filter, And Mobile Layout

Steps:

1. Search archive names, notes, and devices.
2. Filter by device.
3. Repeat on a narrow/mobile viewport.

Expected:

- Search and device filter narrow the archive list correctly.
- Long lists remain scrollable.
- Repository rows and the current write repository remain readable without duplicated repository panels.
- The restore drawer remains usable on mobile.
- Progress UI does not block critical actions.

## Release Gate

Before tagging a release:

- `package.json`, `package-lock.json`, and the plugin info endpoint report `0.3.2`.
- `README.md` and `README_EN.md` describe the current install path and UI entry correctly.
- `CHANGELOG.md` includes the release entry and date.
- The first-repository flow, two-repository switching, cross-device adoption, combined archive library, restore flow, download flow, maintenance breakdown, incomplete-scan GC block, and auto backup have all been tested at least once.
- Automated tests, production JavaScript syntax checks, package dry-run, and `git diff --check` pass before the release is tagged.
