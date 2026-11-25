$ErrorActionPreference = 'Stop'
$manifest = Join-Path $PSScriptRoot '../src-tauri/Cargo.toml'
$cache = Join-Path $PSScriptRoot '../src-tauri/target/release/build'
if (Test-Path -LiteralPath $cache) {
    # Cargo uses two build-script directories per configuration. Bound the
    # embedded copies of the frontend while keeping dependency crates warm.
    $entries = @(Get-ChildItem -LiteralPath $cache -Directory -Filter 'holodori-desktop-*')
    if ($entries.Count -gt 4) {
        & cargo clean --manifest-path $manifest --release --package holodori-desktop
        if ($LASTEXITCODE -ne 0) { throw 'Could not clear stale Planner build outputs.' }
    }
}
& (Join-Path $PSScriptRoot 'build-account-reader.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Account reader build failed.' }
& node (Join-Path $PSScriptRoot 'build-hololive.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
& node (Join-Path $PSScriptRoot 'stage-desktop-shell.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop shell staging failed.' }
