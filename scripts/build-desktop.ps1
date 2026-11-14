$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-account-reader.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Account reader build failed.' }
& node (Join-Path $PSScriptRoot 'build-hololive.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
& node (Join-Path $PSScriptRoot 'stage-desktop-shell.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop shell staging failed.' }
