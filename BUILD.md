# Source and build notes

This repository contains the Windows desktop shell, planner and optimizer code, and release packaging scripts for Hololive Dreams Planner. The [Windows installer](https://github.com/totallynottuco/holodori-planner/releases/latest) is distributed through GitHub Releases.

The public checkout is a source reference. A complete build requires separate inputs from the release workspace, including the desktop UI runtime, game catalog and media, scoring datasets, and the Steam account connector. The build scripts expect those inputs at their existing project-relative paths. The public checkout alone cannot produce the release executable.

The Windows build uses Node.js, Rust, the Windows SDK and Microsoft C++ Build Tools. With the release inputs staged, use the following commands from the project root.

```powershell
npm ci
npm run desktop:build -- --no-bundle
powershell -File scripts/build-windows-setup.ps1 -Compiler <ISCC.exe> -WebView2Installer <WebView2RuntimeInstallerX64.exe>
powershell -File scripts/build-download-setup.ps1 -Compiler <ISCC.exe>
```

The first packaging step requires Inno Setup 6.5 or newer and a Microsoft-signed x64 WebView2 offline installer. The second produces the downloadable Setup executable plus the data that Setup retrieves and verifies during installation.

See [THIRD_PARTY.md](THIRD_PARTY.md) and the [license notices](licenses) for attribution and license terms.
