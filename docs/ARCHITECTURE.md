# Architecture

## Overview

Archive Reserve is a SillyTavern server plugin with a standalone web UI.

Its goal is straightforward:

- back up the active SillyTavern user data directory as one logical archive
- store that archive in GitHub Releases
- support both full restore and selected-path restore across devices
- avoid turning live `data/` into a shared Git working tree

Each repository in a pool uses two release layers:

- one normal backup release per user-visible archive
- one or more hidden chunk-store releases that keep reusable zip chunks

The backup release stores `meta.json`.
The real payload lives in reusable hidden chunk assets referenced by that metadata.

## Main Flows

### 1. Config bootstrap

1. The plugin loads config from `data/.archive-reserve/config.json`.
2. New installations create config v2 after the first repository is added. One member is recorded as the catalog repository and all GitHub credentials remain local.
3. Existing single-repository config is migrated atomically to config v2. The existing repository becomes both the catalog and the first pool member, and its historical backups are adopted without moving them.
4. The standalone UI fetches `/config` and `/status` to render current repository state, operation state, and auto-backup state.

### 2. Backup creation

1. The UI posts a manual backup request to `/backups`.
2. The server resolves the configured backup root:
   - default to `data/default-user`
   - fall back to `data` only when `default-user` does not exist
   - allow another top-level user directory under `data` when selected in settings
3. It resolves the persistent lane for the current device and backup root, then binds the job to that lane's active segment and write repository.
4. It records every file and directory entry except ignored items such as `.gitkeep`, `.DS_Store`, `Thumbs.db`, and `.archive-reserve`. Extension Git metadata is preserved.
5. It groups those entries into stable hidden chunk roots and builds deterministic chunk ids from path, size, and mtime.
6. If a chunk already exists in the selected repository's chunk-store releases, the plugin reuses it. Chunks are never referenced across repositories.
7. Missing chunks are zipped, split if needed, and uploaded to the selected repository.
8. Before the first remote payload write, the plugin confirms that the lane still points to the same segment and repository.
9. It creates one user-visible backup release in that repository and uploads `archive-reserve.meta.json`.
10. Optional retention cleanup can then prune old archives from the same logical lane across its repository segments.

### 3. Archive library and backup download

1. The UI reads `/backups`.
2. The server reads the catalog descriptor, verifies each active member's immutable GitHub id and pool marker, and scans readable members independently. Transient read-only GitHub failures are retried before a member is reported unavailable.
3. A failed member is returned as a partial-result error; it is never represented as an empty repository. A cached descriptor is identified as stale when the live catalog cannot be read.
4. Only releases with the Archive Reserve summary body plus `meta.json` are treated as valid backups. Every result is keyed by `repositoryId + releaseId`, so equal GitHub release ids in different members remain distinct.
5. The UI groups and filters those backups by name, note, device, and displayed backup root.
6. Tree, health-check, and download requests resolve the requested `repositoryId` against the current pool before accessing a release. A multi-member pool rejects an omitted member id; a single-member pool may infer it for compatibility.
7. When the user clicks download, the plugin reconstructs a complete zip from chunks in that same source repository, streams it to the browser, then removes temporary files.

### 4. Full restore and selective restore

1. The UI requests `/backups/:releaseId/tree` to read `meta.json`.
2. The restore dialog builds a tree from `meta.entries`.
3. On restore, the plugin first downloads, extracts, and validates every required path in a temporary staging directory.
4. The plugin rejects restore when the backup root recorded in metadata does not match the currently selected backup root.
5. The plugin resolves which hidden chunks are needed for the selected paths.
6. It downloads only those chunk zips.
7. It extracts only the selected files from those zips.
8. If any required file is missing, the restore fails without modifying the local target.
9. After staging succeeds, `full` replaces the active backup root, `merge` overwrites selected files while keeping other content, and `replace` removes only the selected roots before copying their staged content.

### 5. Health check, space stats, and garbage collection

1. `POST /backups/:releaseId/check` validates one backup:
   - `meta.json` must parse
   - the hidden chunk store must be reachable
   - every referenced chunk asset must exist and match expected size
2. `GET /maintenance/space` scans every active repository's backup releases and hidden chunk stores.
3. It reports pool totals plus:
   - physical bytes, backup counts, and chunk-store usage per repository
   - logical archive bytes and backup counts per device
   - member completeness and catalog freshness
4. Pool totals include:
   - backup release count
   - total backup metadata bytes
   - total chunk-store bytes
   - referenced bytes
   - grace-protected orphan bytes
   - reclaimable orphan bytes
5. `POST /maintenance/gc` deletes orphan chunk assets only after two complete member-scoped scans separated by the grace window. A stale catalog, unavailable member, malformed pagination, or other incomplete scan disables deletion for that run.

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
│ Remote GitHub Repository Pool                   │
│ catalog descriptor + active member descriptors │
│ per-member backup releases and chunk stores     │
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

### Catalog authority and member-scoped reads

The catalog descriptor is the authority for pool membership and backup lane segments. Local descriptor cache data can keep read-only discovery available during a catalog outage, but responses carry stale/partial state and cached data never authorizes writes or destructive maintenance.

Every backup-specific read is bound to one member context before the release id is resolved. This prevents a release id collision in another repository from selecting the wrong metadata or chunk-store assets.

### Selected-path restore downloads only matching chunks

The plugin does not always download the whole archive to restore one folder.
It resolves the needed chunks from metadata and extracts only matching files.

### Grace-protected garbage collection

Orphan chunk assets are not deleted immediately.
A grace window reduces the chance of GC racing with freshly uploaded chunks that are not yet widely referenced.

### Config storage outside `_storage`

Runtime config is kept in `data/.archive-reserve/config.json` rather than SillyTavern's `_storage` tree.
That avoids `EISDIR` startup conflicts with SillyTavern's own key-value storage handling.
