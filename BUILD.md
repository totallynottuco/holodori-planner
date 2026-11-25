# Source and build notes

This repository contains the Windows desktop shell, planner and optimizer code, and release packaging scripts for Hololive Dreams Planner. The [Windows installer](https://github.com/totallynottuco/holodori-planner/releases/latest) is distributed through GitHub Releases.

The public checkout is a source reference. A complete build requires separate inputs from the release workspace, including the desktop UI runtime, game catalog and media, scoring datasets, and the Steam account connector. The build scripts expect those inputs at their existing project-relative paths. The public checkout alone cannot produce the release executable.

The Windows build uses Node.js, Rust, the Windows SDK and Microsoft C++ Build Tools. With the release inputs staged, use the following commands from the project root.

```powershell
npm ci
npm run desktop:build -- --no-bundle
pwsh -File scripts/build-windows-setup.ps1 -Compiler <ISCC.exe> -WebView2Installer <WebView2RuntimeInstallerX64.exe> -PayloadUrl https://github.com/totallynottuco/hololive-dreams-planner-media/releases/download/packs
powershell -File scripts/package-holodori.ps1
powershell -File scripts/verify-holodori-package.ps1 -PackageOnly
```

Packaging requires Inno Setup 6.5 or newer and a Microsoft-signed x64 WebView2 offline installer. Use PowerShell 7 for hosted builds so unchanged media archives retain the same bytes and hashes as the published packs. Upload the verified `hosted-core` parts to the media feed and put the single Setup executable from `release/local-setup/download` on the app release. `release/local-setup` also contains an offline installer and its adjacent payload folder.

See [THIRD_PARTY.md](THIRD_PARTY.md) and the [license notices](licenses) for attribution and license terms.
