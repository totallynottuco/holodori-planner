param([ValidateSet('debug','release')][string]$Configuration = 'release')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'src-tauri\target'
$staging = Join-Path $target $Configuration
if (!(Test-Path -LiteralPath $staging)) { return }
foreach ($dir in @((Join-Path $root 'src-tauri'), $target, $staging)) {
    if ((Resolve-Path -LiteralPath $dir).Path -ne $dir -or
        (Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Unexpected build directory: $dir"
    }
}
# Invalidate the app's build script too, so the next build restages its resources.
& cargo clean --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') --target-dir $target --package holodori-desktop --profile $Configuration.Replace('debug','dev')
if ($LASTEXITCODE -ne 0) { throw 'Could not clear the planner build outputs.' }
foreach ($name in @('animations','capture','chart-artwork','licenses','outfits','soundtracks')) {
    $dir = Join-Path $staging $name
    if (!(Test-Path -LiteralPath $dir)) { continue }
    if ((Resolve-Path -LiteralPath $dir).Path -ne $dir -or
        (Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        (Get-ChildItem -LiteralPath $dir -Force -Recurse -Attributes ReparsePoint | Select-Object -First 1)) {
        throw "Unexpected staged media directory: $dir"
    }
    Remove-Item -LiteralPath $dir -Recurse -Force
}
