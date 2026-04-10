# Data Model

## Local Config File

Stored in:

- `data/.archive-reserve/config.json`

Shape:

```json
{
  "repo": "owner/repo",
  "token": "github-token",
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

- `repo` is normalized to `owner/repo`
- `token` is stored server-side only
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
    "version": "0.1.0"
  },
  "device": {
    "id": "b7d4c1d74b834a5b8fa1c1ce49a5b8f2",
    "name": "MacBook Air"
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

## Hidden Chunk Store Release

The hidden reusable chunk release uses:

- tag: `archivereserve-store-v1`
- name: `Archive Reserve Chunk Store`

It is not a user-visible backup.
It is the backing object store for all current backups in the repository.

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
  "gcGraceHours": 6,
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
