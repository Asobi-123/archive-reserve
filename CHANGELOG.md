# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-04-13

### Changed

- Archive Reserve now preserves `extensions/<name>/.git` metadata in backup creation, backup download, and restore flows, so restored third-party extensions are more likely to remain compatible with SillyTavern's built-in extension update detection.
- `.gitkeep` remains excluded, while extension Git metadata is handled through path-aware filtering instead of the previous blanket `.git` archive ignore rules.

## [0.1.1] - 2026-04-12

### Changed

- Reduced first-open pressure in the standalone UI by removing automatic space-stat loading during bootstrap.
- Archive list loading is now deferred to the archive library tab instead of running unconditionally on page open.
- The maintenance page now starts in a lightweight default state and only performs deep repository space statistics when the user explicitly refreshes it.
- Backup creation and backup deletion no longer immediately trigger a background space-stat refresh, so heavy maintenance scans are less likely to stack on top of other operations.

## [0.1.0] - 2026-04-10

First public repository preparation.

### Added

- SillyTavern server plugin UI for repository setup, backup creation, archive browsing, maintenance, and restore flows.
- Full backup flow that prefers `data/default-user` and falls back to `data`.
- GitHub Releases remote archive storage with automatic empty-repository bootstrap.
- Hidden chunk-store architecture so unchanged data blocks can be reused across later backups.
- Per-device archive library with search, filtering, download, full restore, and path-level restore.
- Two selective restore modes: `merge` and `replace`.
- Progress reporting for backup, restore, download, health check, and manual cleanup flows.
- Optional scheduled auto backup with per-device retention for automatic and manual backups.
- Backup health check, space usage stats, and manual orphan-chunk garbage collection.
- Mobile-aware standalone UI themes and persistent tab/theme state.

### Changed

- The project direction moved away from the old live-Git `cloud-saves` style and now treats GitHub Releases as a snapshot archive instead of a working tree.
- Runtime config storage was moved to `data/.archive-reserve/config.json` so it no longer collides with SillyTavern's `_storage` handling.
- Backup upload and restore paths were optimized around hidden chunk reuse and selected-path extraction.
