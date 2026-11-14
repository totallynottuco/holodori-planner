param(
 [Parameter(Mandatory=$true)][string]$Compiler,
 [Parameter(Mandatory=$true)][string]$WebView2Installer
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build=Get-Content -LiteralPath (Join-Path $projectRoot 'build-info.json') -Raw | ConvertFrom-Json
$compilerPath=(Resolve-Path -LiteralPath $Compiler).Path
$runtimePath=(Resolve-Path -LiteralPath $WebView2Installer).Path
$signature=Get-AuthenticodeSignature -LiteralPath $runtimePath
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){
 throw 'The offline WebView2 installer must have a valid Microsoft signature.'
}
$exe=Get-Item -LiteralPath (Join-Path $projectRoot 'src-tauri\target\release\holodori-desktop.exe')
if($exe.VersionInfo.ProductVersion -ne $build.version){throw "Build the Windows executable for $($build.version) first."}
$release=Join-Path $projectRoot 'release'
& $compilerPath '/Qp' "/O$release" "/DProjectRoot=$projectRoot" "/DAppVersion=$($build.version)" "/DWebView2Installer=$runtimePath" (Join-Path $PSScriptRoot 'holodori-setup.iss')
if($LASTEXITCODE -ne 0){throw 'Windows installer compilation failed.'}
$stem="Hololive-Dreams-Planner-$($build.version)-Windows-x64-Setup"
$assets=@("$stem.exe","$stem-1.bin","$stem-2.bin")
$checksums=foreach($asset in $assets){
 $file=Get-Item -LiteralPath (Join-Path $release $asset)
 if($file.Length -ge 2GB){throw "Release asset exceeds the GitHub size limit: $asset"}
 $hash=Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
 '{0}  {1}' -f $hash.Hash.ToLowerInvariant(),$asset
}
$checksums | Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Encoding Ascii
