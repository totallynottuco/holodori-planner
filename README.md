# holodori Planner

A Windows desktop planner for card progression in *hololive Dreams*. Version 0.1 plans one saved card at a time across Level, SP Training, and Bloom upgrades, checks the required resources against your inventory, and applies completed plans to a local profile.

## Features

- Exact Lv.1–80 EXP and rarity-specific SP Training requirements
- Attribute-aware Bead and Crystal costs
- Card Bloom Points with optional 5★ Bloom Stone substitution
- Multi-card profile and inventory stored in `%APPDATA%\holodori Planner`
- Validated JSON backup export/import with replacement preview
- GitHub Releases update checks with user-approved download and restart
- Original, keyboard-accessible interface with no extracted game assets
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

## Profiles and updates

Account data is never stored in renderer `localStorage`. The Electron main process validates and atomically writes `profile.json`, maintaining `profile.json.bak` for recovery. Import/export uses complete profile backups; v0.1 does not merge profiles.

Stable builds use the repository's GitHub Releases feed. Every release publishes the same `holodori-Planner-Setup.exe` asset name, and local packaging removes superseded installer artifacts before building. NSIS upgrades the fixed per-user installation in place rather than creating version-specific installations. Update checks run shortly after packaged startup and every six hours when enabled. Downloads and restarts always require user action. Builds are unsigned in v0.1, so publisher verification is intentionally disabled while electron-updater still verifies release-file hashes from `latest.yml`. Signature verification must be enabled before signed releases begin.

`npm run shortcut:create` creates `F:\coding\holodori\Holodori Planner.lnk`, targeting the stable installed executable under `%LOCALAPPDATA%\Programs\holodori Planner`.

## Fan-project notice

This is an unofficial fan-made tool. It is not affiliated with, endorsed by, or sponsored by COVER Corp., hololive production, or the developers or publishers of *hololive Dreams*. Product names and trademarks belong to their respective owners.

No official logos, character artwork, game screenshots, or extracted UI assets are included.

See [DATA_ATTRIBUTION.md](DATA_ATTRIBUTION.md) for progression-data provenance.

## License

[MIT](LICENSE)
