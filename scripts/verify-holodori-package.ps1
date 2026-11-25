param([switch]$PackageOnly)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot=Join-Path $projectRoot 'release'
$build=Get-Content -LiteralPath (Join-Path $projectRoot 'build-info.json') -Raw | ConvertFrom-Json
$taskCatalog=Get-Content -LiteralPath (Join-Path $projectRoot 'source\hololive\vendor\data\progression.json') -Raw | ConvertFrom-Json
$taskAnimations=@($taskCatalog.cards | Where-Object { $_.animation }).Count * 3
Add-Type -AssemblyName System.IO.Compression.FileSystem
$libraryRoots=@{
 'outfits'='hololive-dist/assets/outfits'
 'charts'='hololive-dist/assets/chart-artwork'
 'music'='hololive-dist/assets/team-optimizer/soundtracks'
 'animations'='hololive-assets/animations'
}
$count=0
$retiredReferences='(?i)seelie\.me|holodori\.best|prydwen\.gg|seelie offline|honkai|https?://'
$readme=Get-Content -LiteralPath (Join-Path $projectRoot 'README.md') -Raw
if($readme -match $retiredReferences -or $readme -notmatch 'COVER Corporation and QualiArts, Inc\.'){throw 'Unexpected release README'}
$script=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'holodori-setup.iss') -Raw
if($script -notmatch "QueuePayload\('WebView2RuntimeInstaller\.exe'"){throw 'Missing offline WebView2 support'}
if($script -match $retiredReferences){throw 'Unexpected website or product branding in installer'}
foreach($name in @('README.md','THIRD_PARTY.md')){
 if(-not $script.Contains('\'+$name+'"')){throw "Installer is missing $name"}
}
$setupRoot=Join-Path $releaseRoot 'local-setup'
$setup=Join-Path $setupRoot "Hololive-Dreams-Planner-$($build.version)-Windows-x64-Setup.exe"
$setupEntries=@((Split-Path -Leaf $setup),'payload/media-packs.json')
$mediaManifest=Get-Content -LiteralPath (Join-Path $setupRoot 'payload/media-packs.json') -Raw | ConvertFrom-Json
if(Compare-Object @($libraryRoots.Keys | Sort-Object) @($mediaManifest.packs.id | Sort-Object)){throw 'Unexpected installer media packs'}
foreach($pack in $mediaManifest.packs){
 $name=if($mediaManifest.baseUrl){"$($pack.id)-$($pack.sha256).zip"}else{"$($pack.id).zip"}
 $setupEntries+="payload/$name"
 $sourceRoot=(Resolve-Path -LiteralPath (Join-Path $projectRoot $libraryRoots[$pack.id])).Path
 $expected=@{}
 foreach($file in (Get-ChildItem -LiteralPath $sourceRoot -File -Recurse)){
  $expected[$file.FullName.Substring($sourceRoot.Length+1).Replace('\','/')]=$file
 }
 if($pack.id -eq 'animations' -and $expected.Count -ne $taskAnimations){throw 'Incomplete animation library'}
 $zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $setupRoot "payload/$name"))
 try{
  foreach($entry in $zip.Entries){
   $file=$expected[$entry.FullName]
   if(!$file -or $file.Length -ne $entry.Length){throw "Unexpected installer media: $($entry.FullName)"}
   $stream=$entry.Open();$algorithm=[Security.Cryptography.SHA256]::Create()
   try{$hash=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','')}finally{$stream.Dispose();$algorithm.Dispose()}
   if($hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash){throw "Installer media hash mismatch: $($entry.FullName)"}
   $expected.Remove($entry.FullName)
   $count++
  }
  if($expected.Count){throw "Missing media in $name"}
 }finally{$zip.Dispose()}
}
$webView=@(Get-ChildItem -LiteralPath (Join-Path $setupRoot 'payload') -Filter 'WebView2RuntimeInstaller*.exe' -File)
if($webView.Count -ne 1){throw 'Missing or duplicated offline WebView2 payload'}
$setupEntries+="payload/$($webView[0].Name)"
$publishedSetup=$setup
if($mediaManifest.baseUrl){
 $downloadName='download/'+(Split-Path -Leaf $setup)
 $setupEntries+=$downloadName
 $publishedSetup=Join-Path $setupRoot $downloadName
 if((Get-Item -LiteralPath $publishedSetup).Length -gt 32MB){throw 'Download Setup exceeds the updater limit'}
 $parts=@(Get-ChildItem -LiteralPath (Join-Path $setupRoot 'hosted-core') -File | Sort-Object Name)
 if(!$parts.Count -or $parts[0].Name -cnotmatch '^core-([0-9a-f]{64})-000\.bin$'){throw 'Missing hosted core parts'}
 $coreHash=$Matches[1]
 $temporary=Join-Path $setupRoot ([IO.Path]::GetRandomFileName())
 $write=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew)
 try{
  try{
   for($i=0;$i -lt $parts.Count;$i++){
    $part=$parts[$i]
    if($part.Name -cne ('core-{0}-{1:D3}.bin' -f $coreHash,$i)){throw 'Incomplete or mixed hosted core parts'}
    $setupEntries+='hosted-core/'+$part.Name
    $stream=$part.OpenRead()
    try{$stream.CopyTo($write)}finally{$stream.Dispose()}
   }
  }finally{$write.Dispose()}
  if((Get-FileHash -LiteralPath $temporary).Hash -ne $coreHash){throw 'Hosted core does not reconstruct its advertised archive'}
  $files=@{'holodori-desktop.exe'='src-tauri/target/release/holodori-desktop.exe';
   'capture/holodori-account-reader.dll'='src-tauri/resources/capture/holodori-account-reader.dll';
   'README.md'='README.md';'THIRD_PARTY.md'='THIRD_PARTY.md'}
  foreach($license in (Get-ChildItem -LiteralPath (Join-Path $projectRoot 'licenses') -File -Recurse)){
   $name=$license.FullName.Substring($projectRoot.Length+1).Replace('\','/')
   $files[$name]=$name
  }
  $zip=[IO.Compression.ZipFile]::OpenRead($temporary)
  try{
   foreach($entry in $zip.Entries){
    if(!$files.ContainsKey($entry.FullName)){throw "Unexpected or duplicate core entry: $($entry.FullName)"}
    $expectedHash=(Get-FileHash -LiteralPath (Join-Path $projectRoot $files[$entry.FullName])).Hash
    $stream=$entry.Open();$algorithm=[Security.Cryptography.SHA256]::Create()
    try{$hash=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','')}finally{$stream.Dispose();$algorithm.Dispose()}
    if($hash -ne $expectedHash){throw "Hosted core file mismatch: $($entry.FullName)"}
    $files.Remove($entry.FullName)
   }
   if($files.Count){throw 'Hosted core is incomplete'}
  }finally{$zip.Dispose()}
 }finally{Remove-Item -LiteralPath $temporary}
}
$sums=Get-Content -LiteralPath (Join-Path $setupRoot 'SHA256SUMS.txt')
foreach($name in $setupEntries){
 $hash=(Get-FileHash -LiteralPath (Join-Path $setupRoot $name)).Hash.ToLowerInvariant()
 if("$hash  $name" -cnotin $sums){throw "Setup payload hash mismatch: $name"}
}
$checksum=@(Get-Content -LiteralPath (Join-Path $releaseRoot 'holodori-checksums.json') -Raw | ConvertFrom-Json)
$artifact=Get-Item -LiteralPath $publishedSetup
if($checksum.Count -ne 1 -or $checksum[0].name -cne $artifact.Name -or $checksum[0].bytes -ne $artifact.Length -or
 $checksum[0].sha256 -ne (Get-FileHash -LiteralPath $artifact.FullName).Hash){throw 'Release checksum does not match the distributed Setup'}
$versionInfo=$artifact.VersionInfo
if($versionInfo.ProductName.Trim() -ne 'Hololive Dreams Planner' -or $versionInfo.ProductVersion.Trim() -notin @($build.version,"$($build.version).0")){
 throw 'Installer product or version mismatch'
}
if($versionInfo.LegalCopyright -notmatch 'COVER Corporation and QualiArts, Inc\.'){throw 'Missing installer copyright'}
if($PackageOnly){
 Write-Output "PASS current installer metadata, release README, and $count installer media file hashes."
 return
}
$smoke=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/holodori-native-smoke-summary.json') -Raw | ConvertFrom-Json
if(-not $smoke.ok -or $smoke.write.animationWidth -le 0 -or $smoke.restart.animationWidth -le 0){throw 'Native persistence/animation smoke tests did not pass'}
$taskExeHash=(Get-FileHash -LiteralPath (Join-Path $projectRoot 'src-tauri/target/release/holodori-desktop.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
foreach($taskReportName in @('holodori-native-smoke-summary.json','account-native-compatibility-summary.json','catalog-native-smoke-summary.json','reset-native-smoke-summary.json')){
 $taskNativeReport=Get-Content -LiteralPath (Join-Path $projectRoot "evidence/$taskReportName") -Raw | ConvertFrom-Json
 if(-not $taskNativeReport.ok -or $taskNativeReport.exeSha256 -ne $taskExeHash){throw "Native integration report failed or belongs to another executable: $taskReportName"}
}
$taskAccountCompatibility=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/account-native-compatibility-summary.json') -Raw | ConvertFrom-Json
if(-not $taskAccountCompatibility.liveReadVerified){
 $taskPreviousLive=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/account-native-smoke-summary.json') -Raw | ConvertFrom-Json
 if(-not $taskPreviousLive.ok -or $taskPreviousLive.exeSha256 -ne $taskAccountCompatibility.priorLiveExeSha256){throw 'Missing historical live-account evidence for the current compatibility test'}
}
$frontendCount=0
$taskFilters=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/card-filters/verification.json') -Raw | ConvertFrom-Json
if(-not $taskFilters.ok -or $taskFilters.build.version -ne $build.version -or $taskFilters.build.build -ne $build.build -or $taskFilters.checks.Count -lt 5){throw 'Card multi-selection and per-profile persistence verification is incomplete or stale'}
if($taskFilters.events.errors.Count -ne 0 -or $taskFilters.events.failed.Count -ne 0 -or $taskFilters.events.external.Count -ne 0){throw 'Card filtering runtime checks failed'}
foreach($taskUiReportName in @('delete-all-data-ui','game-import-layout','game-import-ui')){
 $taskUiReport=Get-Content -LiteralPath (Join-Path $projectRoot "evidence/auto-import/$taskUiReportName.json") -Raw | ConvertFrom-Json
 if(-not $taskUiReport.ok -or $taskUiReport.events.errors.Count -ne 0 -or $taskUiReport.events.failed.Count -ne 0 -or $taskUiReport.events.external.Count -ne 0){throw "Import/reset UI verification failed: $taskUiReportName"}
}
foreach($name in @('settings-verification','characters-verification','game-verification','inventory-verification','planner-verification','material-planner-verification','persistence-integration')){
 $frontend=Get-Content -LiteralPath (Join-Path $projectRoot "evidence/captured-base/$name.json") -Raw | ConvertFrom-Json
 if(-not $frontend.ok -or $frontend.checks.Count -lt 7 -or $frontend.events.errors.Count -ne 0 -or $frontend.events.external.Count -ne 0 -or $frontend.events.failed.Count -ne 0){throw "Captured Vue workflow checks incomplete: $name"}
 if($frontend.errors.Count -ne 0 -or $frontend.failedAssets.Count -ne 0 -or $frontend.external.Count -ne 0){throw "Captured Vue workflow errors: $name"}
 $frontendCount+=$frontend.checks.Count
}
$artwork=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/artwork.json') -Raw | ConvertFrom-Json
if($artwork.events.errors.Count -ne 0 -or $artwork.events.failed.Count -ne 0 -or $artwork.events.external.Count -ne 0 -or $artwork.state.broken.Count -ne 0 -or $artwork.state.readiness.Count -eq 0){throw 'Original Artwork runtime checks incomplete'}
$motion=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/motion.json') -Raw | ConvertFrom-Json
if(-not $motion.ok -or -not $motion.framesChanged){throw 'Local motion/export checks incomplete'}
$frontendCount+=2
$settingsBridge=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/settings-persistence.json') -Raw | ConvertFrom-Json
if(-not $settingsBridge.ok -or $settingsBridge.checks.Count -lt 8){throw 'Settings failure/retry checks incomplete'}
$settingsComparison=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/settings-comparison.json') -Raw | ConvertFrom-Json
if(-not $settingsComparison.ok -or $settingsComparison.checks.Count -lt 4){throw 'Original Settings comparison incomplete'}
$runtimePerformance=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/performance/runtime-comparison.json') -Raw | ConvertFrom-Json
$visualPerformance=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/performance/visual-loading-verification.json') -Raw | ConvertFrom-Json
$cachePerformance=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/performance/cache-verification.json') -Raw | ConvertFrom-Json
if(-not $runtimePerformance.ok -or $runtimePerformance.background.'planner-hidden'.after -ne 0 -or $runtimePerformance.background.'animation-hidden'.after -ne 0 -or $runtimePerformance.cleanup.pendingRafAfterClose -ne 0){throw 'Performance idle/resume verification incomplete'}
if(-not $visualPerformance.ok -or $visualPerformance.branding.visiblePixelDifferences -ne 0 -or $visualPerformance.branding.alphaDifferences -ne 0 -or -not $cachePerformance.ok -or $cachePerformance.checks -lt 5){throw 'Performance visual/cache compatibility incomplete'}
foreach($name in @('final-mechanics-audit','final-max-target-audit','final-persistence-audit')){
 $audit=Get-Content -LiteralPath (Join-Path $projectRoot "evidence/captured-base/$name.json") -Raw | ConvertFrom-Json
 if(-not $audit.ok -or $audit.findings.Count -ne 0 -or $audit.events.errors.Count -ne 0 -or $audit.events.failed.Count -ne 0 -or $audit.events.external.Count -ne 0){throw "Final app regression incomplete: $name"}
 if($name -eq 'final-persistence-audit' -and $audit.checks.Count -lt 7){throw 'Final artwork persistence cases incomplete'}
}
$uiAudit=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/final-ui/audit.json') -Raw | ConvertFrom-Json
if(-not $uiAudit.ok -or @($uiAudit.states.PSObject.Properties).Count -lt 36 -or $uiAudit.findings.Count -ne 0 -or $uiAudit.events.errors.Count -ne 0 -or $uiAudit.events.failed.Count -ne 0 -or $uiAudit.events.external.Count -ne 0){throw 'Whole-app layout/focus audit incomplete'}
$cardFormat=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/card-assets/ui-verification.json') -Raw | ConvertFrom-Json
if(-not $cardFormat.ok -or $cardFormat.build.version -ne $build.version -or $cardFormat.build.build -ne $build.build -or $cardFormat.checks.Count -lt 11 -or $cardFormat.events.errors.Count -ne 0 -or $cardFormat.events.failed.Count -ne 0 -or $cardFormat.events.external.Count -ne 0){throw 'Horizontal card format checks incomplete or stale'}
$cardLayouts=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/card-layout-audit/verification.json') -Raw | ConvertFrom-Json
if(-not $cardLayouts.ok -or $cardLayouts.build.version -ne $build.version -or $cardLayouts.build.build -ne $build.build -or $cardLayouts.checks.Count -lt 93 -or $cardLayouts.findings.Count -ne 0 -or $cardLayouts.events.errors.Count -ne 0 -or $cardLayouts.events.failed.Count -ne 0){throw 'Card visibility, artwork format/export or upload audit incomplete or stale'}
$source=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/verification.json') -Raw | ConvertFrom-Json
if(-not $source.ok -or $source.version.version -ne $build.version -or $source.version.build -ne $build.build){throw 'Actual captured base verification incomplete or stale'}
$comparison=Get-Content -LiteralPath (Join-Path $projectRoot 'evidence/captured-base/comparison/metrics.json') -Raw | ConvertFrom-Json
if(-not $comparison.ok -or $comparison.checks.Count -lt 6){throw 'Original runtime comparison incomplete'}
$report=[ordered]@{passed=$true;version=$build.version;build=$build.build;renderer='actual-captured-vue';nativePersistence=$smoke.ok;nativeAnimationWidth=$smoke.write.animationWidth;frontendChecks=$frontendCount;capturedComparisonStates=$comparison.checks.Count;installerMediaFilesHashed=$count;animationFiles=$taskAnimations;bundledOfflineWebviewInstaller=$true;checksums=(Get-Content -LiteralPath (Join-Path $releaseRoot 'holodori-checksums.json') -Raw | ConvertFrom-Json)}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $projectRoot 'evidence/holodori-windows-verification.json') -Encoding UTF8
Write-Output 'PASS Holodori package hashes, complete local animations, native persistence, and offline runtime installer.'
