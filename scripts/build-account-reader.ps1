param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\src-tauri\resources\capture'))
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource = Join-Path $taskRoot 'native\account-reader'
$taskBuild = Join-Path $taskSource 'build'
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskBuild,$taskOutput -Force | Out-Null
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $taskVswhere)) { throw 'The installed Visual Studio C++ toolchain could not be located.' }
$taskInstall = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$taskInstall) { throw 'Install the Visual Studio x64 C++ build tools before building the reader.' }
$taskVcvars = Join-Path $taskInstall 'VC\Auxiliary\Build\vcvars64.bat'
$taskEnvironment = & $env:ComSpec /d /s /c "`"$taskVcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the installed MSVC toolchain.' }
foreach ($taskLine in $taskEnvironment) {
  if ($taskLine -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process') }
}
Push-Location $taskBuild
try {
  & cl.exe /nologo /std:c++17 /utf-8 /W4 /EHa /O2 /MT /GS /LD (Join-Path $taskSource 'reader.cpp') /link /DYNAMICBASE /NXCOMPAT /CETCOMPAT '/OUT:holodori-account-reader.dll'
  if ($LASTEXITCODE -ne 0) { throw 'The native account reader failed to compile.' }
  & cl.exe /nologo /std:c++17 /utf-8 /W4 /EHsc /O2 /MT (Join-Path $taskSource 'bounds_test.cpp') '/Fe:bounds_test.exe'
  if ($LASTEXITCODE -ne 0) { throw 'The account-reader bounds tests failed to compile.' }
  & (Join-Path $taskBuild 'bounds_test.exe')
  if ($LASTEXITCODE -ne 0) { throw 'The account-reader bounds tests failed.' }
  Copy-Item -LiteralPath (Join-Path $taskBuild 'holodori-account-reader.dll') -Destination (Join-Path $taskOutput 'holodori-account-reader.dll') -Force
  $taskFile = Get-Item -LiteralPath (Join-Path $taskOutput 'holodori-account-reader.dll')
  Write-Output "Built standalone x64 reader: $($taskFile.FullName) ($($taskFile.Length) bytes)"
} finally { Pop-Location }
