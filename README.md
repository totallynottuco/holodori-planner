# holodori Planner

A Windows desktop planner for card progression in *hololive Dreams*. Version 0.2 tracks goals for multiple cards, aggregates their Level, SP Training, and Bloom requirements, and applies affordable upgrades to a local profile.

## Features

- Exact Lv.1–80 EXP and rarity-specific SP Training requirements
- Attribute-aware Bead and Crystal costs
- Card Bloom Points with optional 5★ Bloom Stone substitution
- Complete 178-card catalog with offline card thumbnails and material icons
- Aggregate multi-card goals with per-card and Apply All completion
- Multi-card profile and inventory stored in `%APPDATA%\holodori Planner`
- Validated JSON backup export/import with replacement preview
- GitHub Releases update checks with user-approved download and restart
- Searchable character grid and compact material inventory
- Fail-closed hardware-GPU rendering: the UI will not start or continue if Chromium cannot provide hardware compositing, rasterization, WebGL, and WebGL2

## Development

Requires Node.js 24 and npm.

The desktop UI requires a working hardware GPU and driver. Software-rendering fallback is intentionally disabled; if GPU initialization fails or the GPU process exits, the app closes with a diagnostic message.

```powershell
npm ci
npm run dev
```

Useful commands:

```powershell
npm run typecheck
npm test
npm run build
npm run package
npm run smoke
npm run shortcut:create
```

To refresh the bundled catalog from a checked-out HolodoriDB data repository:

```powershell
npm run data:import -- C:\path\to\holodori-db-eng-diff
```

The importer rejects duplicate IDs, broken references, EXP-curve mismatches, invalid rarity caps, incomplete Bloom stages, and unknown SP materials. Review the generated manifest diff before release.

To refresh the reviewed thumbnail and material set, install `holodori-asset-tools` and run:

```powershell
npm run assets:import
npm run assets:verify
```

The asset importer downloads only catalog-mapped card thumbnails and progression icons, rejects catalog revision drift, and emits optimized offline WebP files.

## Profiles and updates

Account data is never stored in renderer `localStorage`. The Electron main process validates and atomically writes `profile.json`, maintaining `profile.json.bak` for recovery. Import/export uses complete profile backups; v0.1 does not merge profiles.

Stable builds use the repository's GitHub Releases feed. Every release publishes the same `holodori-Planner-Setup.exe` asset name, and local packaging removes superseded installer artifacts before building. NSIS upgrades the fixed per-user installation in place rather than creating version-specific installations. Update checks run shortly after packaged startup and every six hours when enabled. Downloads and restarts always require user action. Builds are unsigned in v0.1, so publisher verification is intentionally disabled while electron-updater still verifies release-file hashes from `latest.yml`. Signature verification must be enabled before signed releases begin.

`npm run shortcut:create` creates `F:\coding\holodori\Holodori Planner.lnk`, targeting the stable installed executable under `%LOCALAPPDATA%\Programs\holodori Planner`.

## Fan project

Unofficial fan project. Game images, names, and trademarks belong to their respective owners.

See [DATA_ATTRIBUTION.md](DATA_ATTRIBUTION.md) for progression-data provenance.

## License

[MIT](LICENSE)
