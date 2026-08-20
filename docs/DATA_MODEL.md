# Data Model

## Local Config File

Stored in:

- `data/.archive-reserve/config.json`

Shape:

```json
{
  "configVersion": 2,
  "poolId": "pool-random-id",
  "catalogRepositoryId": "repo-random-id",
  "defaultToken": "github-token",
  "repositories": [
    {
      "repositoryId": "repo-random-id",
      "githubRepositoryId": "123456789",
      "repo": "owner/archive-a",
      "tokenOverride": "",
      "addedAt": "2026-08-17T00:00:00.000Z",
      "lastKnownState": {
        "readable": true,
        "writeEligible": true,
        "catalogSynced": true,
        "lastValidatedAt": "2026-08-17T00:00:00.000Z"
      }
    }
  ],
  "descriptorCache": null,
  "backupRoot": "default-user",
  "deviceId": "b7d4c1d74b834a5b8fa1c1ce49a5b8f2",
  "deviceName": "MacBook Air",
  "lastBackupAt": "2026-04-10T10:25:12.000Z",
  "autoBackupEnabled": false,
  "autoBackupIntervalMinutes": 240,
  "autoBackupKeepCount": 12,
  "manualBackupKeepCount": 0
}
```

Notes:

- `catalogRepositoryId` identifies the member that stores the authoritative pool descriptor
- each member `repo` is normalized to `owner/repo`
- `defaultToken` and optional `tokenOverride` values are stored server-side only
- `lastKnownState` is cached display evidence; live validation and a fresh catalog are still required before writes or destructive maintenance
- config v1 is migrated atomically; its repository becomes the catalog and first pool member
- `backupRoot` is a top-level user directory under `data`; empty string means the whole `data` directory
- `manualBackupKeepCount: 0` means unlimited

## Status Payload

Returned by:

- `/status`
- `/config`

Shape:

```json
{
  "configured": true,
  "dataDirectory": "/path/to/SillyTavern/data/default-user",
  "backupRoot": "default-user",
  "backupRootLabel": "data/default-user",
  "currentOperation": "正在创建备份",
  "progress": {
    "label": "正在上传分块 user/images/project-a",
    "detail": "user/images/project-a",
    "current": 3,
    "total": 12,
    "percent": 25
  },
  "autoBackup": {
    "enabled": false,
    "intervalMinutes": 240,
    "keepCount": 12,
    "nextRunAt": null,
    "lastResult": null
  },
  "manualBackupKeepCount": 0
}
```

## Backup Release Summary

Archive Reserve stores a compact JSON summary in each user-visible GitHub release body.

Shape:

```json
{
  "type": "archive-reserve-backup",
  "version": 2,
  "backupId": "b177c31c4b6f4a359b5fef5fc9e76942",
  "name": "Archive 2026-04-10 18.25.12",
  "note": "",
  "automatic": false,
  "createdAt": "2026-04-10T10:25:12.000Z",
  "device": {
    "id": "b7d4c1d74b834a5b8fa1c1ce49a5b8f2",
    "name": "MacBook Air"
  },
  "backupRoot": {
    "root": "default-user",
    "label": "data/default-user"
  },
  "archive": {
    "mode": "chunked",
    "split": false,
    "totalBytes": 734003200,
    "partCount": 41,
    "chunkCount": 19,
    "reusedChunkCount": 14
  },
  "stats": {
    "fileCount": 8321,
    "directoryCount": 517,
    "rawBytes": 905551872
  }
}
```

## Backup Metadata Asset

Each user-visible backup release must contain:

- `archive-reserve.meta.json`

The metadata asset points to all hidden chunks needed to rebuild that backup.

Shape:

```json
{
  "metaVersion": 2,
  "backupId": "b177c31c4b6f4a359b5fef5fc9e76942",
  "tagName": "archive-reserve-1775373879279-b177c31c4b6f4a359b5fef5fc9e76942",
  "name": "Archive 2026-04-10 18.25.12",
  "note": "",
  "automatic": false,
  "createdAt": "2026-04-10T10:25:12.000Z",
  "plugin": {
    "id": "archive-reserve",
    "version": "0.3.3"
  },
  "device": {
    "id": "b7d4c1d74b834a5b8fa1c1ce49a5b8f2",
    "name": "MacBook Air"
  },
  "backupRoot": {
    "root": "default-user",
    "label": "data/default-user"
  },
  "chunkStore": {
    "releaseId": 123456789,
    "tagName": "archivereserve-store-v1",
    "name": "Archive Reserve Chunk Store"
  },
  "archive": {
    "format": "zip",
    "mode": "chunked",
    "thresholdBytes": 1887436800,
    "totalBytes": 734003200,
    "partCount": 41,
    "chunkCount": 19,
    "reusedChunkCount": 14
  },
  "stats": {
    "fileCount": 8321,
    "directoryCount": 517,
    "rawBytes": 905551872
  },
  "entries": [],
  "chunks": []
}
```

## Entry Records

`meta.entries` describes the full restorable tree.

File entry:

```json
{
  "path": "characters/Alice.png",
  "type": "file",
  "size": 582341,
  "mtimeMs": 1775373879279
}
```

Directory entry:

```json
{
  "path": "characters",
  "type": "dir",
  "size": 0,
  "mtimeMs": 0
}
```

## Hidden Chunk Records

`meta.chunks` maps restorable paths to hidden reusable zip chunks.

Shape:

```json
{
  "id": "3b6d8f6b9f3f0a5d5f3d78e6f56f4f1f76bb5c5b97d6f1f8c8427f21a74f7a2d",
  "rootPath": "user/images/project-a",
  "format": "zip",
  "split": false,
  "totalBytes": 12834712,
  "partCount": 1,
  "stats": {
    "fileCount": 134,
    "directoryCount": 1,
    "rawBytes": 14200121
  },
  "parts": [
    {
      "index": 1,
      "name": "archive-reserve.chunk.3b6d8f6b9f3f0a5d5f3d78e6f56f4f1f76bb5c5b97d6f1f8c8427f21a74f7a2d.zip",
      "size": 12834712,
      "sha256": "f0db3c3f8a..."
    }
  ]
}
```

If a chunk exceeds the split threshold, `parts` contains multiple sequential `.partNNN` assets.

## Hidden Chunk Store Releases

The original hidden reusable chunk release uses:

- tag: `archivereserve-store-v1`
- name: `Archive Reserve Chunk Store`

Additional shards use tags such as `archivereserve-store-v2-0001` when an existing store approaches its asset limit. These releases are not user-visible backups. Together they are the backing object store for backups in that repository.

## Restore Modes

The restore endpoint accepts:

- `full`
- `merge`
- `replace`

Behavior:

- `full` clears the active backup root first
- `merge` keeps unselected local content
- `replace` removes selected roots before re-extracting backup content

## Space Stats Result

Returned by:

- `/maintenance/space`

Shape:

```json
{
  "backups": {
    "totalCount": 8,
    "manualCount": 5,
    "automaticCount": 3,
    "metaBytes": 48732
  },
  "chunkStore": {
    "exists": true,
    "releaseId": 123456789,
    "releaseCount": 2,
    "total": {
      "count": 74,
      "bytes": 1803550720
    },
    "referenced": {
      "count": 69,
      "bytes": 1761607680
    },
    "protected": {
      "count": 3,
      "bytes": 20971520
    },
    "reclaimable": {
      "count": 2,
      "bytes": 20971520
    }
  },
  "repositories": [
    {
      "repositoryId": "repo-a",
      "repo": "owner/archive-a",
      "complete": true,
      "error": null,
      "backups": {
        "totalCount": 6,
        "manualCount": 4,
        "automaticCount": 2,
        "metaBytes": 35200
      },
      "chunkStore": {
        "releaseCount": 1,
        "total": { "count": 52, "bytes": 1258291200 },
        "referenced": { "count": 49, "bytes": 1237319680 },
        "reclaimable": { "count": 1, "bytes": 10485760 }
      },
      "totalBytes": 1258326400
    }
  ],
  "devices": [
    {
      "deviceId": "b7d4c1d74b834a5b8fa1c1ce49a5b8f2",
      "deviceName": "MacBook Air",
      "totalCount": 5,
      "manualCount": 3,
      "automaticCount": 2,
      "logicalBytes": 3670016000,
      "repositoryCount": 2
    }
  ],
  "gcGraceHours": 6,
  "complete": true,
  "members": [
    {
      "repositoryId": "repo-a",
      "repo": "owner/archive-a",
      "complete": true,
      "error": null
    }
  ],
  "freshness": {
    "stale": false,
    "error": null
  },
  "checkedAt": "2026-04-10T10:35:12.000Z"
}
```

## Health Check Result

Returned by:

- `/backups/:releaseId/check`

Shape:

```json
{
  "checkedAt": "2026-04-10T10:40:12.000Z",
  "healthy": true,
  "issueCount": 0,
  "issues": [],
  "backup": {},
  "stats": {
    "fileCount": 8321,
    "chunkCount": 19,
    "partCount": 41
  }
}
```

## Repository Pool v1 Contract (Implemented In 0.3.0, Updated In 0.3.3)

This section describes the repository-pool contract implemented by the 0.3.3 runtime.

### Authority And Persistence

- The catalog copy of `.archive-reserve.pool.json` is the only authority for members, lanes, and segments.
- Member descriptor copies are repairable mirrors. Local descriptor data is a cache.
- When a user enters a repository that belongs to an existing remote pool, its immutable GitHub repository ID and marker are validated before that one member is adopted locally. The remote descriptor is read as identity and lane metadata, but its other members are never imported automatically.
- Local configuration is an explicit allowlist. Listing, source resolution, space statistics, garbage collection, and new-lane selection operate only on locally configured members.
- Member activation and write-repository switching synchronize descriptor mirrors only to locally configured active members. Remote-only members never need local credentials and cannot block either operation.
- Deleting a repository row is local-only. It never deletes or edits the GitHub repository, releases, marker, mirror, or remote catalog descriptor.
- A stale local cache may support explicitly marked read-only listing, download, health check, and user-selected restore.
- Backup creation, member admission, segment switching, backup deletion, retention, and GC require a fresh catalog descriptor.
- Local config writes use a validated temporary file, file sync, atomic replacement, and a recoverable pre-migration copy. Invalid JSON or schema never triggers a silent reset.

Local config v2 keeps credentials local:

```json
{
  "configVersion": 2,
  "poolId": "pool-random-id",
  "catalogRepositoryId": "repo-random-id",
  "defaultToken": "local-only-secret",
  "repositories": [
    {
      "repositoryId": "repo-random-id",
      "githubRepositoryId": "123456789",
      "repo": "owner/archive-a",
      "tokenOverride": "",
      "addedAt": "2026-07-25T00:00:00.000Z",
      "lastKnownState": {
        "readable": true,
        "writeEligible": true,
        "catalogSynced": true,
        "lastValidatedAt": "2026-07-25T00:00:00.000Z"
      }
    }
  ],
  "descriptorCache": {
    "revision": 12,
    "sha": "github-contents-sha",
    "fetchedAt": "2026-07-25T00:00:00.000Z",
    "stale": false,
    "descriptor": {}
  }
}
```

`lastKnownState` and `descriptorCache` may support status display and explicitly marked stale reads. They never permanently authorize writes, repository switching, backup deletion, retention, or garbage collection; those operations require current remote validation.

### Remote Files And Identity

The historical `.archive-reserve` file remains untouched. Pool data uses two non-conflicting top-level files:

- `.archive-reserve.pool.json`: authoritative in the catalog and mirrored to active members.
- `.archive-reserve.pool.marker.json`: immutable member ownership marker.

Marker shape:

```json
{
  "version": 1,
  "poolId": "pool-random-id",
  "repositoryId": "repo-random-id",
  "githubRepositoryId": "123456789",
  "catalogRepositoryId": "repo-catalog-id",
  "createdAt": "2026-07-25T00:00:00.000Z"
}
```

`repositoryId` is generated by Archive Reserve. `githubRepositoryId` is the normalized string form of GitHub's immutable repository ID. Every connection verifies both IDs and the marker; the mutable `owner/repo` slug is not sufficient identity.

Descriptor shape:

```json
{
  "version": 1,
  "revision": 12,
  "poolId": "pool-random-id",
  "catalogRepositoryId": "repo-catalog-id",
  "members": [
    {
      "repositoryId": "repo-random-id",
      "githubRepositoryId": "123456789",
      "repo": "owner/archive-a",
      "membershipState": "active",
      "addedAt": "2026-07-25T00:00:00.000Z"
    }
  ],
  "backupLanes": {
    "lane-random-id": {
      "identity": {
        "backupRoot": "default-user",
        "deviceId": "current-device-id",
        "deviceIdAliases": ["confirmed-old-device-id"],
        "deviceNameKeyHash": "sha256:normalized-name-hash"
      },
      "segments": [
        {
          "segmentId": "segment-random-id",
          "repositoryId": "repo-catalog-id",
          "startedAt": null,
          "reason": "legacy-initial"
        }
      ]
    }
  },
  "updatedAt": "2026-07-25T00:00:00.000Z"
}
```

The marker has no descriptor revision. `catalogSynced` compares the catalog descriptor revision with the member descriptor mirror revision.

### Member Admission And Capabilities

New-member admission is resumable for empty repositories:

1. Validate GitHub repository identity, permissions, and that the repository has no existing Archive Reserve content.
2. CAS a `membershipState: pending` member into the catalog descriptor.
3. Write the matching marker and descriptor mirror.
4. CAS the member to `membershipState: active` and mirror the new revision.

A pending member is never readable or writable through pool operations. It may be removed only when it has never been active, contains no Archive Reserve release/chunk payload, and its marker exactly matches the pending admission being cancelled. Active member removal is out of scope.

Existing-pool adoption is a separate read-only path. It requires a valid marker and descriptor for the manually entered repository, adopts only that member into local configuration, and does not create or update remote descriptor or mirror files.

Runtime capabilities are derived rather than stored in the remote descriptor:

| Capability | Required state |
| --- | --- |
| `readable` | Active member, verified GitHub ID and marker, read permission available. |
| `catalogSynced` | Member descriptor mirror matches the current catalog revision. |
| `writeEligible` | Active, readable, catalog-synced, and write permission verified. |

A mirror failure may set `catalogSynced=false` and `writeEligible=false` without hiding otherwise readable historical backups.

### Local Orphan Ledger

`data/.archive-reserve/orphan-ledger.json` is an atomically written, member-scoped observation ledger. An asset becomes GC-eligible only when the same immutable release/asset identity appears as unreferenced in two complete pool scans separated by the grace interval. Any catalog, release, metadata, chunk-store, or ledger read failure leaves the ledger unchanged and authorizes no deletion.

Deleting a backup release and applying retention never delete chunk assets inline. They only make assets candidates for a later complete GC scan. Identical release or asset names in different repositories remain isolated by `repositoryId`.

### Historical Lane Resolution

The first v1 migration reads a complete catalog backup-release inventory before constructing lanes.

1. Group valid historical summaries by `(backupRoot, exact deviceId)`.
2. When device ID is absent, group by `(backupRoot, normalized deviceName)` only if that name identifies exactly one historical sequence.
3. Keep different exact device IDs in different lanes even when names match.
4. Put ambiguous, invalid-time, or multiply matching records in an unresolved set excluded from automatic deletion.
5. Give each migrated lane one catalog segment with `startedAt: null`, meaning negative infinity.

Later segments use ISO timestamps. A legacy backup belongs to the unique interval `[segment.startedAt, nextSegment.startedAt)`. A new device ID may become an alias only when its normalized device name and backup root resolve to exactly one lane; aliases cannot appear in multiple lanes.

### CAS Operation Rules

Catalog updates use both GitHub Contents `sha` and monotonic descriptor `revision`.

| Operation | Retry rule | Conflict result |
| --- | --- | --- |
| Add distinct member | Merge only when repository, marker, and generated IDs do not conflict. | Reject identity conflicts. |
| Create lane | Re-resolve identity after reread; append only if no unique lane now exists. | Reuse the unique lane or reject ambiguity. |
| Switch segment | Require the expected active `segmentId` to remain active. | Return HTTP 409; never last-write-wins. |
| Repair mirror | Write the exact current catalog descriptor revision. | Reread catalog and retry finitely. |

Backup creation records `{ laneId, segmentId, repositoryId, descriptorRevision }`, completes local scanning, then revalidates that reservation before any remote payload write. This check is mandatory even when every chunk is reusable and no chunk upload occurs.

### Completeness And Failure Matrix

Every member scan returns `complete`, `stale`, or `failed`, plus `checkedAt`. Stale data is display evidence, never deletion evidence.

| Condition | Read-only behavior | Write/destructive behavior |
| --- | --- | --- |
| Catalog unavailable, verified cache present | List/download/check/selected restore may continue with `stale=true`. | Backup, admission, switching, deletion, retention, and GC fail closed. |
| One member release list fails | Return other members plus a partial-failure record. | Failed member is excluded from maintenance. |
| Any backup meta read fails | Preserve visible records where possible and report the failure. | No retention or GC for that member. |
| Chunk-store list is incomplete | Health/space result reports incomplete. | No GC for that member. |
| Member mirror is stale | Historical reads may continue when identity is verified. | Member is not a backup destination. |
| Reservation changes before remote write | No remote payload is created. | Backup returns a retryable conflict. |
| Reservation changes after revalidation | Existing run remains bound to its recorded segment. | Later runs use the new segment. |
| Meta upload fails after chunk upload | No old backup is pruned. | New orphan chunks enter grace-protected GC flow. |
| Ordinary upload fails | Report the source member failure. | Never switch repository automatically. |

Automatic new-lane placement uses referenced chunk bytes only when every `writeEligible` candidate has a complete, fresh release + meta + chunk-store scan. Ties use stable `repositoryId` order. With multiple candidates and any unknown/stale statistic, the user must choose explicitly.

### Destructive Maintenance And Restore Safety

- A backup release is committed only after its metadata asset uploads successfully. Retention runs after that commit.
- Deleting a backup removes only its backup release. It does not immediately run chunk GC.
- GC requires the same member-scoped asset to be absent from two complete reference scans separated by at least `CHUNK_GC_GRACE_MS`.
- GC evidence is atomically persisted under local `.archive-reserve` state with `{ repositoryId, githubRepositoryId, assetId, assetName, firstSeenAt, lastCompleteScanAt }`.
- Incomplete or stale scans neither delete assets nor advance `lastCompleteScanAt`.
- `full`, `merge`, and `replace` restore download and validate all required chunks into staging before modifying the target directory.
- Concurrent deletion is idempotent. Retention revalidates lane ownership and the keep window before each deletion.

### Member-Aware API Contract

Every backup-specific operation addresses `(repositoryId, releaseId)`. Download carries `repositoryId` in its query. Omitting it is compatible only while the pool has exactly one member; a missing, unknown, or foreign ID is rejected in multi-member mode.

`GET /backups` returns:

- backups with `repositoryId` and a readable source label, plus member capability and freshness records;
- partial failures for unread members and a response-level stale indicator when cache data contributed.

An unread member is never represented as an empty member.

### Test Injection Boundary

GitHub transport is injected below repository-pool logic. Tests independently control member responses and simulate duplicate release IDs, Contents API 409/422 conflicts, repository-ID and marker mismatches, permission failures, timeouts, incomplete pagination, stale cache, mirror repair, reservation races with and without chunk uploads, restore versus remote deletion/GC, and token redaction.

Pure model and routing tests never require real GitHub access.
