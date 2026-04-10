# Architecture

## Overview

Archive Reserve is a SillyTavern server plugin with a standalone web UI.

Its goal is straightforward:

- back up the active SillyTavern user data directory as one logical archive
- store that archive in GitHub Releases
- support both full restore and selected-path restore across devices
- avoid turning live `data/` into a shared Git working tree

The current implementation uses two release layers:

- one normal backup release per user-visible archive
- one hidden chunk-store release that keeps reusable zip chunks

The backup release stores `meta.json`.
The real payload lives in reusable hidden chunk assets referenced by that metadata.

## Main Flows

### 1. Config bootstrap

1. The plugin loads config from `data/.archive-reserve/config.json`.
2. If that file does not exist, it creates a fresh config with a generated device id.
3. It can migrate legacy config from older paths.
4. The standalone UI fetches `/config` and `/status` to render current repository state, operation state, and auto-backup state.

### 2. Backup creation

1. The UI posts a manual backup request to `/backups`.
2. The server scans the live backup root:
   - prefer `data/default-user`
   - fall back to `data`
3. It records every file and directory entry except ignored items such as `.git`, `.gitkeep`, `.DS_Store`, `Thumbs.db`, and `.archive-reserve`.
4. It groups those entries into stable hidden chunk roots.
5. For each chunk group, it builds a deterministic chunk id from path, size, and mtime.
6. If the hidden chunk already exists in the chunk-store release, the plugin reuses it.
7. If not, the plugin zips that chunk, splits it if needed, uploads the parts, and records the result.
8. After all chunks are ready, the plugin writes `archive-reserve.meta.json`.
9. It creates one user-visible backup release and uploads only the metadata asset there.
10. Optional retention cleanup can then prune old archives from the same device.

### 3. Archive library and backup download

1. The UI reads `/backups`.
2. The server scans all releases in the configured repository.
3. Only releases with the Archive Reserve summary body plus `meta.json` are treated as valid backups.
4. The UI groups and filters those backups by name, note, and device.
5. When the user clicks download, the plugin reconstructs a complete zip from hidden chunks, streams it to the browser, then removes temporary files.

### 4. Full restore and selective restore

1. The UI requests `/backups/:releaseId/tree` to read `meta.json`.
2. The restore dialog builds a tree from `meta.entries`.
3. On restore:
   - `full` clears the entire active backup root first
   - `merge` keeps everything except files explicitly overwritten by the backup
   - `replace` removes only the selected roots first
4. The plugin resolves which hidden chunks are needed for the selected paths.
5. It downloads only those chunk zips.
6. It extracts only the selected files from those zips.
7. If any required file is still missing after all relevant chunks are processed, the restore fails with an explicit missing-file list.

### 5. Health check, space stats, and garbage collection

1. `POST /backups/:releaseId/check` validates one backup:
   - `meta.json` must parse
   - the hidden chunk store must be reachable
   - every referenced chunk asset must exist and match expected size
2. `GET /maintenance/space` scans current backup releases and the hidden chunk store.
3. It reports:
   - backup release count
   - total backup metadata bytes
   - total chunk-store bytes
   - referenced bytes
   - grace-protected orphan bytes
   - reclaimable orphan bytes
4. `POST /maintenance/gc` deletes orphan chunk assets that are no longer referenced by any backup and are older than the grace window.

### 6. Scheduled auto backup

1. The plugin restores auto-backup scheduling from saved config at startup.
2. If auto backup is enabled, it schedules the next run using the configured interval.
3. When the timer fires:
   - it skips if another job is already running
   - otherwise it creates a backup marked as automatic
4. After a successful run, it prunes old automatic backups for the current device.
5. The next run is scheduled again after completion or failure.

## Chunking Strategy

Chunk roots are designed to keep later uploads smaller while preserving a simple user-facing full-backup model.

Current rules:

- top-level by default
- second-level chunks for:
  - `chats`
  - `assets`
  - `extensions`
  - `vectors`
  - `thumbnails`
- deeper user hotspots for:
  - `user/images/<project>`
  - `user/files/<subdir>`
  - otherwise `user/<second-level>`

This lets Archive Reserve reuse unchanged hot directories instead of re-uploading the entire data tree every time.

## Layer Diagram

```text
┌──────────────────────────────────────────────────┐
│ Standalone UI                                   │
│ public/index.html                               │
│ public/style.css                                │
│ public/app.js                                   │
├──────────────────────────────────────────────────┤
│ Plugin API Layer                                │
│ /api/plugins/archive-reserve/*                  │
│ config / status / backups / restore / download  │
│ maintenance / health check / auto-backup state  │
├──────────────────────────────────────────────────┤
│ Server Plugin Core                              │
│ index.js                                        │
│ config load/save                                │
│ entry scan                                      │
│ chunk build/reuse                               │
│ release metadata build                          │
│ restore / download reconstruction               │
│ health / GC / auto-backup                       │
├──────────────────────────────────────────────────┤
│ Local Runtime State                             │
│ data/.archive-reserve/config.json               │
│ temporary work dirs under system tmp            │
├──────────────────────────────────────────────────┤
│ Remote GitHub Repository                        │
│ backup releases: meta.json + summary body       │
│ hidden chunk-store release: reusable zip parts  │
└──────────────────────────────────────────────────┘
```

## Key Design Decisions

### GitHub Releases instead of live Git working tree

Archive Reserve does not keep a persistent Git database inside the live SillyTavern user data directory.
That avoids the local `.git` storage bloat that motivated this project in the first place.

### One logical full backup, hidden physical chunks

The user sees one backup.
The backend stores reusable hidden chunks.
This keeps the UX simple while still reducing repeat upload cost.

### Backup release stores metadata, not the entire payload

Each visible backup release is lightweight.
The heavy payload lives in the hidden chunk-store release and is referenced by `meta.json`.

### Selected-path restore downloads only matching chunks

The plugin does not always download the whole archive to restore one folder.
It resolves the needed chunks from metadata and extracts only matching files.

### Grace-protected garbage collection

Orphan chunk assets are not deleted immediately.
A grace window reduces the chance of GC racing with freshly uploaded chunks that are not yet widely referenced.

### Config storage outside `_storage`

Runtime config is kept in `data/.archive-reserve/config.json` rather than SillyTavern's `_storage` tree.
That avoids `EISDIR` startup conflicts with SillyTavern's own key-value storage handling.
