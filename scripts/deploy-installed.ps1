param([string]$InstalledDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Holodori Planner'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'src-tauri\target\release'
$install = (Resolve-Path -LiteralPath $InstalledDirectory).Path
$exe = Join-Path $install 'holodori-desktop.exe'
if ((Get-Item -LiteralPath $exe).VersionInfo.ProductName -ne 'Hololive Dreams Planner' -or
    !(Test-Path -LiteralPath (Join-Path $install 'unins000.dat') -PathType Leaf)) {
    throw 'Choose the existing Windows installation of Hololive Dreams Planner.'
}
$version = (Get-Content -LiteralPath (Join-Path $root 'build-info.json') -Raw | ConvertFrom-Json).version
$sources = [ordered]@{
    'capture\holodori-account-reader.dll' = (Join-Path $root 'src-tauri\resources\capture\holodori-account-reader.dll')
    'README.md' = (Join-Path $root 'README.md')
    'holodori-desktop.exe' = (Join-Path $build 'holodori-desktop.exe')
}
if ((Get-Item -LiteralPath $sources['holodori-desktop.exe']).VersionInfo.ProductVersion -ne $version) {
    throw 'The Windows build does not match build-info.json.'
}
if ((Get-FileHash -LiteralPath $sources['capture\holodori-account-reader.dll']).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $build 'capture\holodori-account-reader.dll')).Hash) {
    throw 'The staged account reader is stale.'
}

# The exclusive handle serializes deployments and Windows removes the lock on exit.
$lock = [IO.FileStream]::new((Join-Path $install '.planner-deploy.lock'), [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
try {
    $changed = @()
    foreach ($name in $sources.Keys) {
        $target = Join-Path $install $name
        if ((Test-Path -LiteralPath "$target.rollback") -or
            (Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $sources[$name]).Hash) {
            $changed += $name
        }
    }
    if ($changed.Count -gt 0 -and (Get-Process -Name 'holodori-desktop' -ErrorAction SilentlyContinue | Where-Object Path -eq $exe)) {
        throw 'Close the installed planner before updating it.'
    }
    try {
        foreach ($name in $changed) {
            $target = Join-Path $install $name
            # Recover an interrupted deployment before staging its replacement.
            if (Test-Path -LiteralPath "$target.rollback") {
                [IO.File]::Replace("$target.rollback", $target, [NullString]::Value)
            }
            Copy-Item -LiteralPath $sources[$name] -Destination "$target.update" -Force
            if ((Get-FileHash -LiteralPath "$target.update").Hash -ne (Get-FileHash -LiteralPath $sources[$name]).Hash) {
                throw "Staging verification failed for $name."
            }
        }
        foreach ($name in $changed) {
            $target = Join-Path $install $name
            [IO.File]::Replace("$target.update", $target, "$target.rollback")
        }
        foreach ($name in $sources.Keys) {
            if ((Get-FileHash -LiteralPath (Join-Path $install $name)).Hash -ne (Get-FileHash -LiteralPath $sources[$name]).Hash) {
                throw "Installation verification failed for $name."
            }
        }
    } catch {
        foreach ($name in $changed) {
            $target = Join-Path $install $name
            if (Test-Path -LiteralPath "$target.rollback") {
                [IO.File]::Replace("$target.rollback", $target, [NullString]::Value)
            }
        }
        throw
    } finally {
        foreach ($name in $sources.Keys) {
            $stage = (Join-Path $install $name) + '.update'
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage }
        }
    }
    foreach ($name in $changed) {
        Remove-Item -LiteralPath ((Join-Path $install $name) + '.rollback')
    }
    Write-Output "Verified $exe ($($changed.Count) updated files)."
} finally {
    $lock.Dispose()
}
