param(
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$holodoriDirectory = Split-Path -Parent $projectDirectory
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $holodoriDirectory 'Holodori Planner.lnk'
}

$executable = Join-Path $env:LOCALAPPDATA 'Programs\holodori Planner\holodori Planner.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "The installed holodori Planner executable was not found at $executable"
}

$destinationDirectory = Split-Path -Parent $Destination
if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
  throw "The shortcut destination directory does not exist: $destinationDirectory"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($Destination)
$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = Split-Path -Parent $executable
$shortcut.IconLocation = "$executable,0"
$shortcut.Description = 'Open holodori Planner'
$shortcut.Save()

Write-Output "Shortcut created: $Destination"
