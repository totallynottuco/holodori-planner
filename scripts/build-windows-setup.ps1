param(
    [Parameter(Mandatory=$true)][string]$Compiler,
    [Parameter(Mandatory=$true)][string]$WebView2Installer,
    [string]$PayloadUrl,
    [string]$HostedSplitPlan
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build=Get-Content -LiteralPath (Join-Path $root 'build-info.json') -Raw | ConvertFrom-Json
$compilerPath=(Resolve-Path -LiteralPath $Compiler).Path
$runtimePath=(Resolve-Path -LiteralPath $WebView2Installer).Path
$signature=Get-AuthenticodeSignature -LiteralPath $runtimePath
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){
    throw 'The offline WebView2 installer must have a valid Microsoft signature.'
}
if($PayloadUrl -and $PayloadUrl -cnotmatch '^https://[a-zA-Z0-9.-]+(?:/[a-zA-Z0-9._~/-]*)?$'){
    throw 'Pass a stable HTTPS payload directory URL without a query string or fragment.'
}
$exe=Get-Item -LiteralPath (Join-Path $root 'src-tauri/target/release/holodori-desktop.exe')
if($exe.VersionInfo.ProductVersion -ne $build.version){throw "Build the Windows executable for $($build.version) first."}

$release=Join-Path $root 'release'
$output=Join-Path $release 'local-setup'
$staging=Join-Path $release ".setup-staging-$PID"
$previous=Join-Path $release ".setup-previous-$PID"
$payload=Join-Path $staging 'payload'
$setupName="Hololive-Dreams-Planner-$($build.version)-Windows-x64-Setup.exe"
$libraries=[ordered]@{
    Outfits=@('hololive-dist/assets/outfits','outfits.zip','(?:^index\.json$|\.(?:webp|gz)$)')
    Animations=@('hololive-assets/animations','animations.zip','\.webm$')
    Charts=@('hololive-dist/assets/chart-artwork','charts.zip','(?:^index\.json$|\.png$)')
    Music=@('hololive-dist/assets/team-optimizer/soundtracks','music.zip','(?:^index\.json$|\.ogg$)')
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-ArchiveEntry($archive, $file, $name, $compression) {
    if($name -notmatch '^[a-zA-Z0-9._/-]+$' -or ($name.Split('/') -contains '..')){
        throw "Unexpected archive path: $name"
    }
    $entry=$archive.CreateEntry($name,$compression)
    # Identical content should retain its hash when a rebuild touches source timestamps.
    $entry.LastWriteTime=[DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
    $inputFile=[IO.File]::OpenRead($file)
    try{
        $outputEntry=$entry.Open()
        try{$inputFile.CopyTo($outputEntry)}finally{$outputEntry.Dispose()}
    }finally{$inputFile.Dispose()}
}

function Write-MediaArchive($libraryRoot, $archivePath, $pattern) {
    $base=(Resolve-Path -LiteralPath $libraryRoot).Path
    $files=@(Get-ChildItem -LiteralPath $base -File -Recurse | Sort-Object FullName)
    if($files.Count -eq 0){throw "The media library is empty: $libraryRoot"}
    $archive=[IO.Compression.ZipFile]::Open($archivePath,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach($file in $files){
            $name=$file.FullName.Substring($base.Length+1).Replace('\','/')
            if($name -notmatch $pattern){throw "Unexpected file in media library: $name"}
            Write-ArchiveEntry $archive $file.FullName $name ([IO.Compression.CompressionLevel]::NoCompression)
        }
    } finally {$archive.Dispose()}
}

function Write-CoreArchive($archivePath) {
    $files=[ordered]@{
        'holodori-desktop.exe'=$exe.FullName
        'capture/holodori-account-reader.dll'=(Join-Path $root 'src-tauri/resources/capture/holodori-account-reader.dll')
        'README.md'=(Join-Path $root 'README.md')
        'THIRD_PARTY.md'=(Join-Path $root 'THIRD_PARTY.md')
    }
    $licenseDirectory=Join-Path $root 'licenses'
    foreach($file in (Get-ChildItem -LiteralPath $licenseDirectory -Recurse -File | Sort-Object FullName)){
        $files[$file.FullName.Substring($root.Length+1).Replace('\','/')]=$file.FullName
    }
    $archive=[IO.Compression.ZipFile]::Open($archivePath,[IO.Compression.ZipArchiveMode]::Create)
    try{
        foreach($name in $files.Keys){Write-ArchiveEntry $archive $files[$name] $name ([IO.Compression.CompressionLevel]::Fastest)}
    }finally{$archive.Dispose()}
}

function Remove-GeneratedDirectory($directory, $leaf) {
    if(!(Test-Path -LiteralPath $directory)){return}
    $resolved=(Resolve-Path -LiteralPath $directory).Path
    if((Split-Path -Parent $resolved) -ne $release -or (Split-Path -Leaf $resolved) -ne $leaf){
        throw "Unexpected generated directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

if((Test-Path -LiteralPath $staging) -or (Test-Path -LiteralPath $previous)){throw 'Setup staging directory already exists.'}
if(Test-Path -LiteralPath $output){
    $existing=Get-Item -LiteralPath $output
    if(!$existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        !(Test-Path -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -PathType Leaf)){
        throw 'The existing local-setup folder is not a generated package.'
    }
}
[void](New-Item -ItemType Directory -Path $payload -Force)
try {
    $packRows=[Collections.Generic.List[object]]::new()
    $definitions=@(foreach($key in $libraries.Keys){
        $source,$name,$pattern=$libraries[$key]
        $media=Join-Path $payload $name
        Write-MediaArchive (Join-Path $root $source) $media $pattern
        $bytes=(Get-Item -LiteralPath $media).Length
        if($bytes -ge 2GB){throw "The optional pack exceeds the release asset size limit: $name"}
        $hash=(Get-FileHash -LiteralPath $media).Hash.ToLowerInvariant()
        $packRows.Add([ordered]@{id=[IO.Path]::GetFileNameWithoutExtension($name);size=$bytes;sha256=$hash})
        if($PayloadUrl){Rename-Item -LiteralPath $media -NewName ($name -replace '\.zip$',"-$hash.zip")}
        '#define {0}Bytes {1}' -f $key,$bytes
        '#define {0}Hash "{1}"' -f $key,$hash
    })
    $runtime=Join-Path $payload 'WebView2RuntimeInstaller.exe'
    Copy-Item -LiteralPath $runtimePath -Destination $runtime
    $runtimeHash=(Get-FileHash -LiteralPath $runtime).Hash.ToLowerInvariant()
    $definitions += '#define WebView2Hash "{0}"' -f $runtimeHash
    if($PayloadUrl){Rename-Item -LiteralPath $runtime -NewName "WebView2RuntimeInstaller-$runtimeHash.exe"}
    if($PayloadUrl){$definitions += '#define PayloadUrl "{0}"' -f $PayloadUrl.TrimEnd('/')}
    $manifestPath=Join-Path $payload 'media-packs.json'
    $manifest=[ordered]@{schema=1;revision=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
        baseUrl=$(if($PayloadUrl){$PayloadUrl.TrimEnd('/')}else{$null});packs=@($packRows.ToArray())}
    $manifest | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $manifestPath -Encoding Ascii
    if($PayloadUrl){
        $core=Join-Path $payload 'core.zip'
        Write-CoreArchive $core
        $coreBytes=(Get-Item -LiteralPath $core).Length
        $coreHash=(Get-FileHash -LiteralPath $core).Hash.ToLowerInvariant()
        $coreArchive=Join-Path $payload "core-$coreHash.zip"
        Move-Item -LiteralPath $core -Destination $coreArchive
        $hostedIndex=Join-Path $staging 'hosted-payload-index.txt'
        $chunkArguments=@($payload,$manifestPath,$hostedIndex)
        $defaultPlan=Join-Path $PSScriptRoot 'media-feed-partitions.json'
        if(!$HostedSplitPlan -and (Test-Path -LiteralPath $defaultPlan)){$HostedSplitPlan=$defaultPlan}
        $partitions=if($HostedSplitPlan){(Resolve-Path -LiteralPath $HostedSplitPlan).Path}else{'-'}
        $chunkArguments+=@('-',$partitions,(Join-Path $staging 'hosted-core'))
        node (Join-Path $PSScriptRoot 'chunk-media-feed.mjs') @chunkArguments
        if($LASTEXITCODE -ne 0){throw 'Hosted media index generation failed.'}
        $definitions += '#define HostedPayloadIndex "{0}"' -f $hostedIndex
    }
    $definitions += '#define MediaManifest "{0}"' -f $manifestPath
    $metadata=Join-Path $staging 'payload-metadata.iss'
    $definitions | Set-Content -LiteralPath $metadata -Encoding Ascii
    & $compilerPath '/Q' "/O$staging" "/DProjectRoot=$root" "/DAppVersion=$($build.version)" "/DPayloadMetadata=$metadata" (Join-Path $PSScriptRoot 'holodori-setup.iss')
    if($LASTEXITCODE -ne 0){throw 'Windows Setup compilation failed.'}
    if($PayloadUrl){
        $download=Join-Path $staging 'download'
        [void](New-Item -ItemType Directory -Path $download)
        Add-Content -LiteralPath $metadata -Encoding Ascii -Value @(
            ('#define CoreBytes {0}' -f $coreBytes), ('#define CoreHash "{0}"' -f $coreHash)
        )
        & $compilerPath '/Q' "/O$download" "/DProjectRoot=$root" "/DAppVersion=$($build.version)" "/DPayloadMetadata=$metadata" (Join-Path $PSScriptRoot 'holodori-setup.iss')
        if($LASTEXITCODE -ne 0){throw 'Download Setup compilation failed.'}
        if((Get-Item -LiteralPath (Join-Path $download $setupName)).Length -gt 32MB){
            throw 'The download Setup exceeds the installed updater size limit.'
        }
        Remove-Item -LiteralPath $coreArchive
    }
    Remove-Item -LiteralPath $metadata
    if($PayloadUrl){Remove-Item -LiteralPath $hostedIndex}
    $checksums=Get-ChildItem -LiteralPath $staging -File -Recurse | Sort-Object FullName | ForEach-Object {
        '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant(),$_.FullName.Substring($staging.Length+1).Replace('\','/')
    }
    $checksums | Set-Content -LiteralPath (Join-Path $staging 'SHA256SUMS.txt') -Encoding Ascii
    if(Test-Path -LiteralPath $output){
        if((Resolve-Path -LiteralPath $output).Path -ne $output){throw 'Unexpected local Setup output path.'}
        Move-Item -LiteralPath $output -Destination $previous
    }
    try {
        if((Resolve-Path -LiteralPath $staging).Path -ne $staging){throw 'Unexpected Setup staging path.'}
        Move-Item -LiteralPath $staging -Destination $output
    } catch {
        if((Test-Path -LiteralPath $previous) -and !(Test-Path -LiteralPath $output)){
            if((Resolve-Path -LiteralPath $previous).Path -ne $previous){throw 'Unexpected previous Setup path.'}
            Move-Item -LiteralPath $previous -Destination $output
        }
        throw
    }
    Remove-GeneratedDirectory $previous ".setup-previous-$PID"
    Get-Item -LiteralPath (Join-Path $output $setupName) | Select-Object FullName,Length
} finally {
    Remove-GeneratedDirectory $staging ".setup-staging-$PID"
}
