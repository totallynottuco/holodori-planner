$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'release'
$version = (Get-Content -LiteralPath (Join-Path $root 'build-info.json') -Raw | ConvertFrom-Json).version
$package = Join-Path $release 'local-setup'
$manifest = Get-Content -LiteralPath (Join-Path $package 'payload/media-packs.json') -Raw | ConvertFrom-Json
$directory = if ($manifest.baseUrl) { Join-Path $package 'download' } else { $package }
$setup = Get-Item -LiteralPath (Join-Path $directory "Hololive-Dreams-Planner-$version-Windows-x64-Setup.exe")
$hashes = @([ordered]@{name=$setup.Name;bytes=$setup.Length;sha256=(Get-FileHash -LiteralPath $setup.FullName).Hash.ToLowerInvariant()})
ConvertTo-Json -InputObject $hashes | Set-Content -LiteralPath (Join-Path $release 'holodori-checksums.json') -Encoding UTF8
$hashes
