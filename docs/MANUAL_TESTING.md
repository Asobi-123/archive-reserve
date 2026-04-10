# Manual Testing Checklist

This checklist is for release validation before publishing a new Archive Reserve version.

## Preconditions

- SillyTavern starts without server-plugin load errors.
- `plugins/archive-reserve` exists in the target SillyTavern root.
- `config.yaml` has `enableServerPlugins: true`.
- A GitHub test repository and usable token are ready.
- Test at least one desktop viewport and one mobile/narrow viewport.

## 1. Config Save And Reload

Steps:

1. Open `/api/plugins/archive-reserve/ui`.
2. Fill repository, token, and device name.
3. Save settings.
4. Restart SillyTavern.
5. Open the page again.

Expected:

- Repository remains filled.
- Token is not shown in full, but saved-state hint is visible.
- Device name persists.
- Auto-backup settings persist.

## 2. Empty Repository Bootstrap

Steps:

1. Point Archive Reserve at a brand-new empty private repository.
2. Save settings.
3. Create the first backup.

Expected:

- The plugin initializes the repository if GitHub allows it.
- If GitHub refuses, the error is clear enough to tell the user to add an initial commit.

## 3. First Manual Backup

Steps:

1. Create a manual backup with a custom note.
2. Wait for completion.
3. Refresh the archive library.

Expected:

- One new archive appears.
- Device name, created time, size, and note are correct.
- The status panel returns to idle after completion.

## 4. Later Backup Reuse

Steps:

1. Make a limited change inside a hotspot directory such as `user/images/<project>` or `user/files/<subdir>`.
2. Create another backup.

Expected:

- The second backup succeeds.
- It should not behave like a full first-time upload again.
- The backup metadata still reconstructs into a complete archive.

## 5. Full Restore

Steps:

1. Prepare a local change that is easy to verify.
2. Pick an older backup.
3. Run full restore.

Expected:

- The selected backup fully replaces the active backup root.
- The changed local content is reverted to the backup state.

## 6. Selective Restore

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

## 7. Download Export

Steps:

1. Choose an archive.
2. Click download.
3. Inspect the exported zip.

Expected:

- Download completes without `ENOENT` or missing-file errors.
- The zip contains a complete reconstructable data tree for that backup.

## 8. Health Check

Steps:

1. Run `检查` on a valid archive.

Expected:

- The plugin reports a healthy result.
- File, chunk, and part counts are shown.
- If a chunk is missing in the repository, the error should list it explicitly.

## 9. Space Stats And Manual GC

Steps:

1. Open `维护`.
2. Refresh space stats.
3. Run manual garbage collection.

Expected:

- Space stats render correctly.
- Refresh gives visible feedback.
- GC returns a result even when nothing is reclaimable.
- Reclaimable space decreases after orphan chunks are deleted.

## 10. Auto Backup

Steps:

1. Enable auto backup.
2. Choose an hourly interval.
3. Set an automatic retention count.
4. Wait for one scheduled run.

Expected:

- Auto-backup state survives restart.
- One scheduled backup is created.
- Retention deletes older automatic archives from the same device when over limit.

## 11. Search, Filter, And Mobile Layout

Steps:

1. Search archive names, notes, and devices.
2. Filter by device.
3. Repeat on a narrow/mobile viewport.

Expected:

- Search and device filter narrow the archive list correctly.
- Long lists remain scrollable.
- The restore drawer remains usable on mobile.
- Progress UI does not block critical actions.

## Release Gate

Before tagging a release:

- `package.json` version matches the intended release version.
- `README.md` and `README_EN.md` describe the current install path and UI entry correctly.
- `CHANGELOG.md` includes the release entry and date.
- The archive library, restore flow, download flow, health check, space stats, and auto backup have all been tested at least once.
