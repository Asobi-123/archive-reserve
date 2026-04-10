# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
